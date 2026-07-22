/** Prefix a site path with Astro's configured base (e.g. /lain-xin/). */
export function withBase(path = '/') {
	const raw = import.meta.env.BASE_URL || '/';
	const base = raw.endsWith('/') ? raw : `${raw}/`;
	if (!path || path === '/') return base;
	const clean = path.startsWith('/') ? path.slice(1) : path;
	return `${base}${clean}`;
}
