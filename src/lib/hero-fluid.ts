/**
 * Hero Stable Fluids — dye field rendered as phosphor glow.
 * Stam / PavelDoGreat WebGL pipeline; bloom & sunrays stripped.
 */

type FBO = {
	texture: WebGLTexture;
	fbo: WebGLFramebuffer;
	width: number;
	height: number;
	texelSizeX: number;
	texelSizeY: number;
	attach: (id: number) => number;
};

type DoubleFBO = {
	width: number;
	height: number;
	texelSizeX: number;
	texelSizeY: number;
	read: FBO;
	write: FBO;
	swap: () => void;
};

type Format = { internalFormat: number; format: number };

export type HeroFluidHandle = {
	destroy: () => void;
};

const CONFIG = {
	SIM_RESOLUTION: 128,
	DYE_RESOLUTION: 512,
	DENSITY_DISSIPATION: 0.55,
	VELOCITY_DISSIPATION: 0.25,
	PRESSURE: 0.8,
	PRESSURE_ITERATIONS: 20,
	CURL: 18,
	/** Pavel divides by 100 — soft ink brush */
	SPLAT_RADIUS: 0.55,
	SPLAT_FORCE: 2800,
	/** Phosphor #7cffb2 — quieter so edges can bloom without flooding */
	DYE: { r: 0.08, g: 0.48, b: 0.22 },
	DISPLAY_OPACITY: 0.7,
};

export function mountHeroFluid(
	hero: HTMLElement,
	canvas: HTMLCanvasElement,
	options: { reduceMotion?: boolean; finePointer?: boolean } = {},
): HeroFluidHandle | null {
	const reduceMotion = Boolean(options.reduceMotion);
	const finePointer = options.finePointer ?? matchMedia('(pointer: fine)').matches;

	const params: WebGLContextAttributes = {
		alpha: true,
		depth: false,
		stencil: false,
		antialias: false,
		preserveDrawingBuffer: true,
		premultipliedAlpha: false,
		powerPreference: 'low-power',
	};

	const gl =
		(canvas.getContext('webgl2', params) as WebGL2RenderingContext | null) ||
		(canvas.getContext('webgl', params) as WebGLRenderingContext | null);
	if (!gl) return null;

	const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
	const halfFloat = isWebGL2 ? null : gl.getExtension('OES_texture_half_float');
	const floatLinear = Boolean(
		isWebGL2
			? gl.getExtension('OES_texture_float_linear')
			: gl.getExtension('OES_texture_half_float_linear'),
	);

	if (isWebGL2) {
		if (!gl.getExtension('EXT_color_buffer_float')) return null;
	} else if (!halfFloat) {
		return null;
	}

	const g2 = gl as WebGL2RenderingContext;
	let texType: number;
	let formatRGBA: Format | null;
	let formatRG: Format | null;
	let formatR: Format | null;

	if (isWebGL2) {
		// Prefer 32F — half-float dye sampling is flaky across GPUs
		texType = g2.FLOAT;
		formatRGBA = getSupportedFormat(gl, g2.RGBA32F, gl.RGBA, texType);
		formatRG = getSupportedFormat(gl, g2.RG32F, g2.RG, texType);
		formatR = getSupportedFormat(gl, g2.R32F, g2.RED, texType);
		if (!formatRGBA || !formatRG || !formatR) {
			texType = g2.HALF_FLOAT;
			formatRGBA = getSupportedFormat(gl, g2.RGBA16F, gl.RGBA, texType);
			formatRG = getSupportedFormat(gl, g2.RG16F, g2.RG, texType);
			formatR = getSupportedFormat(gl, g2.R16F, g2.RED, texType);
		}
	} else {
		texType = (halfFloat as OES_texture_half_float).HALF_FLOAT_OES;
		formatRGBA = getSupportedFormat(gl, gl.RGBA, gl.RGBA, texType);
		formatRG = formatRGBA;
		formatR = formatRGBA;
	}

	if (!formatRGBA || !formatRG || !formatR) return null;

	gl.clearColor(0, 0, 0, 0);

	const compileShader = (type: number, source: string) => {
		const shader = gl.createShader(type);
		if (!shader) throw new Error('shader alloc failed');
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
			console.warn('[hero-fluid] shader compile failed', gl.getShaderInfoLog(shader));
		}
		return shader;
	};

	const createProgram = (vs: WebGLShader, fs: WebGLShader) => {
		const program = gl.createProgram();
		if (!program) throw new Error('program alloc failed');
		gl.attachShader(program, vs);
		gl.attachShader(program, fs);
		gl.bindAttribLocation(program, 0, 'aPosition');
		gl.linkProgram(program);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			console.warn('[hero-fluid] program link failed', gl.getProgramInfoLog(program));
		}
		return program;
	};

	const getUniforms = (program: WebGLProgram) => {
		const uniforms: Record<string, WebGLUniformLocation | null> = {};
		const n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
		for (let i = 0; i < n; i++) {
			const info = gl.getActiveUniform(program, i);
			if (!info) continue;
			uniforms[info.name] = gl.getUniformLocation(program, info.name);
		}
		return uniforms;
	};

	class Program {
		program: WebGLProgram;
		uniforms: Record<string, WebGLUniformLocation | null>;
		constructor(vs: WebGLShader, fs: WebGLShader) {
			this.program = createProgram(vs, fs);
			this.uniforms = getUniforms(this.program);
		}
		bind() {
			gl.useProgram(this.program);
		}
	}

	const baseVertexShader = compileShader(
		gl.VERTEX_SHADER,
		`
		precision highp float;
		attribute vec2 aPosition;
		varying vec2 vUv;
		varying vec2 vL;
		varying vec2 vR;
		varying vec2 vT;
		varying vec2 vB;
		uniform vec2 texelSize;
		void main () {
			vUv = aPosition * 0.5 + 0.5;
			vL = vUv - vec2(texelSize.x, 0.0);
			vR = vUv + vec2(texelSize.x, 0.0);
			vT = vUv + vec2(0.0, texelSize.y);
			vB = vUv - vec2(0.0, texelSize.y);
			gl_Position = vec4(aPosition, 0.0, 1.0);
		}
	`,
	);

	const clearShader = compileShader(
		gl.FRAGMENT_SHADER,
		`
		precision mediump float;
		precision mediump sampler2D;
		varying highp vec2 vUv;
		uniform sampler2D uTexture;
		uniform float value;
		void main () {
			gl_FragColor = value * texture2D(uTexture, vUv);
		}
	`,
	);

	const displayShader = compileShader(
		gl.FRAGMENT_SHADER,
		`
		precision highp float;
		precision highp sampler2D;
		varying vec2 vUv;
		uniform sampler2D uTexture;
		uniform float opacity;
		void main () {
			vec3 c = texture2D(uTexture, vUv).rgb;
			c = max(c, 0.0);
			c = c / (c + vec3(0.55));
			c *= opacity;
			float a = min(0.8, max(c.r, max(c.g, c.b)) * 1.3);
			gl_FragColor = vec4(c, a);
		}
	`,
	);

	const splatShader = compileShader(
		gl.FRAGMENT_SHADER,
		`
		precision highp float;
		precision highp sampler2D;
		varying vec2 vUv;
		uniform sampler2D uTarget;
		uniform float aspectRatio;
		uniform vec3 color;
		uniform vec2 point;
		uniform float radius;
		void main () {
			vec2 p = vUv - point.xy;
			p.x *= aspectRatio;
			vec3 splat = exp(-dot(p, p) / radius) * color;
			vec3 base = texture2D(uTarget, vUv).xyz;
			gl_FragColor = vec4(base + splat, 1.0);
		}
	`,
	);

	const advectionShader = compileShader(
		gl.FRAGMENT_SHADER,
		`
		precision highp float;
		precision highp sampler2D;
		varying vec2 vUv;
		uniform sampler2D uVelocity;
		uniform sampler2D uSource;
		uniform vec2 texelSize;
		uniform vec2 dyeTexelSize;
		uniform float dt;
		uniform float dissipation;

		vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
			vec2 st = uv / tsize - 0.5;
			vec2 iuv = floor(st);
			vec2 fuv = fract(st);
			vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
			vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
			vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
			vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
			return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
		}

		void main () {
			vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
			vec4 result = bilerp(uSource, coord, dyeTexelSize);
			float decay = 1.0 + dissipation * dt;
			gl_FragColor = result / decay;
		}
	`,
	);

	const divergenceShader = compileShader(
		gl.FRAGMENT_SHADER,
		`
		precision mediump float;
		precision mediump sampler2D;
		varying highp vec2 vUv;
		varying highp vec2 vL;
		varying highp vec2 vR;
		varying highp vec2 vT;
		varying highp vec2 vB;
		uniform sampler2D uVelocity;
		void main () {
			float L = texture2D(uVelocity, vL).x;
			float R = texture2D(uVelocity, vR).x;
			float T = texture2D(uVelocity, vT).y;
			float B = texture2D(uVelocity, vB).y;
			vec2 C = texture2D(uVelocity, vUv).xy;
			if (vL.x < 0.0) { L = -C.x; }
			if (vR.x > 1.0) { R = -C.x; }
			if (vT.y > 1.0) { T = -C.y; }
			if (vB.y < 0.0) { B = -C.y; }
			float div = 0.5 * (R - L + T - B);
			gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
		}
	`,
	);

	const curlShader = compileShader(
		gl.FRAGMENT_SHADER,
		`
		precision mediump float;
		precision mediump sampler2D;
		varying highp vec2 vUv;
		varying highp vec2 vL;
		varying highp vec2 vR;
		varying highp vec2 vT;
		varying highp vec2 vB;
		uniform sampler2D uVelocity;
		void main () {
			float L = texture2D(uVelocity, vL).y;
			float R = texture2D(uVelocity, vR).y;
			float T = texture2D(uVelocity, vT).x;
			float B = texture2D(uVelocity, vB).x;
			float vorticity = R - L - T + B;
			gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
		}
	`,
	);

	const vorticityShader = compileShader(
		gl.FRAGMENT_SHADER,
		`
		precision highp float;
		precision highp sampler2D;
		varying vec2 vUv;
		varying vec2 vL;
		varying vec2 vR;
		varying vec2 vT;
		varying vec2 vB;
		uniform sampler2D uVelocity;
		uniform sampler2D uCurl;
		uniform float curl;
		uniform float dt;
		void main () {
			float L = texture2D(uCurl, vL).x;
			float R = texture2D(uCurl, vR).x;
			float T = texture2D(uCurl, vT).x;
			float B = texture2D(uCurl, vB).x;
			float C = texture2D(uCurl, vUv).x;
			vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
			force /= length(force) + 0.0001;
			force *= curl * C;
			force.y *= -1.0;
			vec2 velocity = texture2D(uVelocity, vUv).xy;
			velocity += force * dt;
			velocity = clamp(velocity, -1000.0, 1000.0);
			gl_FragColor = vec4(velocity, 0.0, 1.0);
		}
	`,
	);

	const pressureShader = compileShader(
		gl.FRAGMENT_SHADER,
		`
		precision mediump float;
		precision mediump sampler2D;
		varying highp vec2 vUv;
		varying highp vec2 vL;
		varying highp vec2 vR;
		varying highp vec2 vT;
		varying highp vec2 vB;
		uniform sampler2D uPressure;
		uniform sampler2D uDivergence;
		void main () {
			float L = texture2D(uPressure, vL).x;
			float R = texture2D(uPressure, vR).x;
			float T = texture2D(uPressure, vT).x;
			float B = texture2D(uPressure, vB).x;
			float divergence = texture2D(uDivergence, vUv).x;
			float pressure = (L + R + B + T - divergence) * 0.25;
			gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
		}
	`,
	);

	const gradientSubtractShader = compileShader(
		gl.FRAGMENT_SHADER,
		`
		precision mediump float;
		precision mediump sampler2D;
		varying highp vec2 vUv;
		varying highp vec2 vL;
		varying highp vec2 vR;
		varying highp vec2 vT;
		varying highp vec2 vB;
		uniform sampler2D uPressure;
		uniform sampler2D uVelocity;
		void main () {
			float L = texture2D(uPressure, vL).x;
			float R = texture2D(uPressure, vR).x;
			float T = texture2D(uPressure, vT).x;
			float B = texture2D(uPressure, vB).x;
			vec2 velocity = texture2D(uVelocity, vUv).xy;
			velocity.xy -= vec2(R - L, T - B);
			gl_FragColor = vec4(velocity, 0.0, 1.0);
		}
	`,
	);

	const clearProgram = new Program(baseVertexShader, clearShader);
	const splatProgram = new Program(baseVertexShader, splatShader);
	const advectionProgram = new Program(baseVertexShader, advectionShader);
	const divergenceProgram = new Program(baseVertexShader, divergenceShader);
	const curlProgram = new Program(baseVertexShader, curlShader);
	const vorticityProgram = new Program(baseVertexShader, vorticityShader);
	const pressureProgram = new Program(baseVertexShader, pressureShader);
	const gradientSubtractProgram = new Program(baseVertexShader, gradientSubtractShader);
	const displayProgram = new Program(baseVertexShader, displayShader);

	const quadBuffer = gl.createBuffer();
	const indexBuffer = gl.createBuffer();
	if (!quadBuffer || !indexBuffer) return null;
	gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
	gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
	gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);

	const blit = (target: FBO | null, clear = false) => {
		gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
		gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
		gl.enableVertexAttribArray(0);

		if (target) {
			gl.viewport(0, 0, target.width, target.height);
			gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
		} else {
			gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		}
		if (clear) {
			gl.clearColor(0, 0, 0, 0);
			gl.clear(gl.COLOR_BUFFER_BIT);
		}
		gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
	};

	const createFBO = (
		w: number,
		h: number,
		internalFormat: number,
		format: number,
		type: number,
		param: number,
	): FBO => {
		gl.activeTexture(gl.TEXTURE0);
		const texture = gl.createTexture();
		if (!texture) throw new Error('texture alloc failed');
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

		const fbo = gl.createFramebuffer();
		if (!fbo) throw new Error('fbo alloc failed');
		gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
		gl.viewport(0, 0, w, h);
		gl.clear(gl.COLOR_BUFFER_BIT);

		return {
			texture,
			fbo,
			width: w,
			height: h,
			texelSizeX: 1 / w,
			texelSizeY: 1 / h,
			attach(id: number) {
				gl.activeTexture(gl.TEXTURE0 + id);
				gl.bindTexture(gl.TEXTURE_2D, texture);
				return id;
			},
		};
	};

	const createDoubleFBO = (
		w: number,
		h: number,
		internalFormat: number,
		format: number,
		type: number,
		param: number,
	): DoubleFBO => {
		let fbo1 = createFBO(w, h, internalFormat, format, type, param);
		let fbo2 = createFBO(w, h, internalFormat, format, type, param);
		return {
			width: w,
			height: h,
			texelSizeX: fbo1.texelSizeX,
			texelSizeY: fbo1.texelSizeY,
			get read() {
				return fbo1;
			},
			set read(v) {
				fbo1 = v;
			},
			get write() {
				return fbo2;
			},
			set write(v) {
				fbo2 = v;
			},
			swap() {
				const tmp = fbo1;
				fbo1 = fbo2;
				fbo2 = tmp;
			},
		};
	};

	const getResolution = (resolution: number) => {
		let aspect = gl.drawingBufferWidth / Math.max(1, gl.drawingBufferHeight);
		if (aspect < 1) aspect = 1 / aspect;
		const min = Math.round(resolution);
		const max = Math.round(resolution * aspect);
		if (gl.drawingBufferWidth > gl.drawingBufferHeight) {
			return { width: max, height: min };
		}
		return { width: min, height: max };
	};

	let dye!: DoubleFBO;
	let velocity!: DoubleFBO;
	let divergence!: FBO;
	let curl!: FBO;
	let pressure!: DoubleFBO;

	const initFramebuffers = () => {
		const simRes = getResolution(CONFIG.SIM_RESOLUTION);
		const dyeRes = getResolution(CONFIG.DYE_RESOLUTION);
		const simFilter = gl.NEAREST;
		const dyeFilter = floatLinear ? gl.LINEAR : gl.NEAREST;
		gl.disable(gl.BLEND);

		dye = createDoubleFBO(
			dyeRes.width,
			dyeRes.height,
			formatRGBA.internalFormat,
			formatRGBA.format,
			texType,
			dyeFilter,
		);
		velocity = createDoubleFBO(
			simRes.width,
			simRes.height,
			formatRG.internalFormat,
			formatRG.format,
			texType,
			simFilter,
		);
		divergence = createFBO(
			simRes.width,
			simRes.height,
			formatR.internalFormat,
			formatR.format,
			texType,
			gl.NEAREST,
		);
		curl = createFBO(
			simRes.width,
			simRes.height,
			formatR.internalFormat,
			formatR.format,
			texType,
			gl.NEAREST,
		);
		pressure = createDoubleFBO(
			simRes.width,
			simRes.height,
			formatR.internalFormat,
			formatR.format,
			texType,
			gl.NEAREST,
		);
	};

	const correctRadius = (radius: number) => {
		let aspect = canvas.width / Math.max(1, canvas.height);
		if (aspect > 1) radius *= aspect;
		return radius;
	};

	const dyeColor = (scale = 1) => ({
		r: CONFIG.DYE.r * scale,
		g: CONFIG.DYE.g * scale,
		b: CONFIG.DYE.b * scale,
	});

	const splat = (x: number, y: number, dx: number, dy: number, color: { r: number; g: number; b: number }) => {
		splatProgram.bind();
		gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read.attach(0));
		gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / Math.max(1, canvas.height));
		gl.uniform2f(splatProgram.uniforms.point, x, y);
		gl.uniform3f(splatProgram.uniforms.color, dx, dy, 0);
		gl.uniform1f(splatProgram.uniforms.radius, correctRadius(CONFIG.SPLAT_RADIUS / 100));
		blit(velocity.write);
		velocity.swap();

		gl.uniform1i(splatProgram.uniforms.uTarget, dye.read.attach(0));
		gl.uniform3f(splatProgram.uniforms.color, color.r, color.g, color.b);
		blit(dye.write);
		dye.swap();
	};

	const step = (dt: number) => {
		gl.disable(gl.BLEND);

		curlProgram.bind();
		gl.uniform2f(curlProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
		gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.read.attach(0));
		blit(curl);

		vorticityProgram.bind();
		gl.uniform2f(vorticityProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
		gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.read.attach(0));
		gl.uniform1i(vorticityProgram.uniforms.uCurl, curl.attach(1));
		gl.uniform1f(vorticityProgram.uniforms.curl, CONFIG.CURL);
		gl.uniform1f(vorticityProgram.uniforms.dt, dt);
		blit(velocity.write);
		velocity.swap();

		divergenceProgram.bind();
		gl.uniform2f(divergenceProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
		gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read.attach(0));
		blit(divergence);

		clearProgram.bind();
		gl.uniform1i(clearProgram.uniforms.uTexture, pressure.read.attach(0));
		gl.uniform1f(clearProgram.uniforms.value, CONFIG.PRESSURE);
		blit(pressure.write);
		pressure.swap();

		pressureProgram.bind();
		gl.uniform2f(pressureProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
		gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence.attach(0));
		for (let i = 0; i < CONFIG.PRESSURE_ITERATIONS; i++) {
			gl.uniform1i(pressureProgram.uniforms.uPressure, pressure.read.attach(1));
			blit(pressure.write);
			pressure.swap();
		}

		gradientSubtractProgram.bind();
		gl.uniform2f(gradientSubtractProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
		gl.uniform1i(gradientSubtractProgram.uniforms.uPressure, pressure.read.attach(0));
		gl.uniform1i(gradientSubtractProgram.uniforms.uVelocity, velocity.read.attach(1));
		blit(velocity.write);
		velocity.swap();

		advectionProgram.bind();
		gl.uniform2f(advectionProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
		gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, velocity.texelSizeX, velocity.texelSizeY);
		const velocityId = velocity.read.attach(0);
		gl.uniform1i(advectionProgram.uniforms.uVelocity, velocityId);
		gl.uniform1i(advectionProgram.uniforms.uSource, velocityId);
		gl.uniform1f(advectionProgram.uniforms.dt, dt);
		gl.uniform1f(advectionProgram.uniforms.dissipation, CONFIG.VELOCITY_DISSIPATION);
		blit(velocity.write);
		velocity.swap();

		gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
		gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
		gl.uniform1i(advectionProgram.uniforms.uSource, dye.read.attach(1));
		gl.uniform1f(advectionProgram.uniforms.dissipation, CONFIG.DENSITY_DISSIPATION);
		blit(dye.write);
		dye.swap();
	};

	const render = () => {
		gl.disable(gl.BLEND);
		gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);

		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

		displayProgram.bind();
		gl.uniform1i(displayProgram.uniforms.uTexture, dye.read.attach(0));
		gl.uniform1f(displayProgram.uniforms.opacity, CONFIG.DISPLAY_OPACITY);
		gl.uniform2f(displayProgram.uniforms.texelSize, dye.texelSizeX, dye.texelSizeY);
		blit(null);
	};

	const resize = () => {
		const rect = hero.getBoundingClientRect();
		const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
		const width = Math.max(2, Math.round(rect.width * dpr));
		const height = Math.max(2, Math.round(rect.height * dpr));
		if (Math.abs(canvas.width - width) < 2 && Math.abs(canvas.height - height) < 2) return false;
		canvas.width = width;
		canvas.height = height;
		initFramebuffers();
		return true;
	};

	let pointer = {
		x: 0.72,
		y: 0.36,
		px: 0.72,
		py: 0.36,
		moved: false,
		inside: false,
	};

	const toTex = (clientX: number, clientY: number) => {
		const r = hero.getBoundingClientRect();
		return {
			x: (clientX - r.left) / Math.max(1, r.width),
			y: 1 - (clientY - r.top) / Math.max(1, r.height),
		};
	};

	const onEnter = (e: PointerEvent) => {
		const p = toTex(e.clientX, e.clientY);
		pointer = { x: p.x, y: p.y, px: p.x, py: p.y, moved: false, inside: true };
		hovering = true;
		kick();
	};

	const onMove = (e: PointerEvent) => {
		const p = toTex(e.clientX, e.clientY);
		pointer.px = pointer.x;
		pointer.py = pointer.y;
		pointer.x = p.x;
		pointer.y = p.y;
		pointer.moved = true;
		pointer.inside = true;
		hovering = true;
		kick();
	};

	const onLeave = () => {
		pointer.inside = false;
		pointer.moved = false;
		hovering = false;
		// Let residual velocity wind down instead of freezing mid-swirl
		settleUntil = performance.now() + 900;
		kick();
	};

	let raf = 0;
	let last = performance.now();
	let destroyed = false;
	/** Only inject / step hard while hovered; settle briefly after leave */
	let hovering = false;
	let settleUntil = 0;

	const frame = (now: number) => {
		raf = 0;
		if (destroyed) return;

		const dt = Math.min((now - last) / 1000, 1 / 30);
		last = now;

		if (!reduceMotion) {
			if (pointer.moved && pointer.inside) {
				const force = finePointer ? CONFIG.SPLAT_FORCE : CONFIG.SPLAT_FORCE * 0.45;
				const dx = (pointer.x - pointer.px) * force;
				const dy = (pointer.y - pointer.py) * force;
				if (Math.abs(dx) + Math.abs(dy) > 0.5) {
					splat(pointer.x, pointer.y, dx, dy, dyeColor(0.65));
				}
				pointer.moved = false;
			}

			// Flow only while hovering (plus a short settle so trails don't hard-stop)
			if (hovering || now < settleUntil) {
				step(dt);
			}
		}

		render();
		const keepGoing = !reduceMotion && (hovering || now < settleUntil);
		if (keepGoing) raf = requestAnimationFrame(frame);
	};

	const kick = () => {
		if (!raf && !destroyed) raf = requestAnimationFrame(frame);
	};

	resize();
	render();

	const ro = new ResizeObserver(() => {
		if (resize()) render();
	});
	ro.observe(hero);

	if (!reduceMotion) {
		hero.addEventListener('pointerenter', onEnter, { passive: true });
		hero.addEventListener('pointermove', onMove, { passive: true });
		hero.addEventListener('pointerleave', onLeave, { passive: true });
	}

	const onVisibility = () => {
		if (document.visibilityState === 'visible') kick();
	};
	document.addEventListener('visibilitychange', onVisibility);

	return {
		destroy() {
			destroyed = true;
			if (raf) cancelAnimationFrame(raf);
			raf = 0;
			ro.disconnect();
			document.removeEventListener('visibilitychange', onVisibility);
			hero.removeEventListener('pointerenter', onEnter);
			hero.removeEventListener('pointermove', onMove);
			hero.removeEventListener('pointerleave', onLeave);
		},
	};
}

function getSupportedFormat(
	gl: WebGLRenderingContext | WebGL2RenderingContext,
	internalFormat: number,
	format: number,
	type: number,
): Format | null {
	if (!supportRenderTextureFormat(gl, internalFormat, format, type)) {
		const g2 = gl as WebGL2RenderingContext;
		switch (internalFormat) {
			case g2.R16F:
				return getSupportedFormat(gl, g2.RG16F, g2.RG, type);
			case g2.RG16F:
				return getSupportedFormat(gl, g2.RGBA16F, g2.RGBA, type);
			default:
				return null;
		}
	}
	return { internalFormat, format };
}

function supportRenderTextureFormat(
	gl: WebGLRenderingContext | WebGL2RenderingContext,
	internalFormat: number,
	format: number,
	type: number,
) {
	const texture = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, texture);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);

	const fbo = gl.createFramebuffer();
	gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
	const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
	return status === gl.FRAMEBUFFER_COMPLETE;
}
