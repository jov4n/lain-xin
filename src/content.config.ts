import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const projects = defineCollection({
	loader: glob({ pattern: '**/*.md', base: './src/content/projects' }),
	schema: z.object({
		title: z.string(),
		summary: z.string(),
		status: z.enum(['active', 'building', 'signal', 'archived']),
		tags: z.array(z.string()).default([]),
		year: z.string(),
		order: z.number().default(99),
		link: z.string().url().optional(),
	}),
});

const posts = defineCollection({
	loader: glob({ pattern: '**/*.md', base: './src/content/posts' }),
	schema: z.object({
		title: z.string(),
		summary: z.string(),
		date: z.coerce.date(),
		draft: z.boolean().default(false),
	}),
});

const lab = defineCollection({
	loader: glob({ pattern: '**/*.md', base: './src/content/lab' }),
	schema: z.object({
		title: z.string(),
		date: z.coerce.date(),
		channel: z.string().default('lab'),
		project: z.string().optional(),
	}),
});

const opensource = defineCollection({
	loader: glob({ pattern: '**/*.md', base: './src/content/open-source' }),
	schema: z.object({
		title: z.string(),
		summary: z.string(),
		repo: z.string().url().optional(),
		language: z.string().optional(),
		order: z.number().default(99),
	}),
});

const services = defineCollection({
	loader: glob({ pattern: '**/*.md', base: './src/content/services' }),
	schema: z.object({
		title: z.string(),
		summary: z.string(),
		order: z.number().default(99),
	}),
});

const pages = defineCollection({
	loader: glob({ pattern: '**/*.md', base: './src/content/pages' }),
	schema: z.object({
		title: z.string(),
		description: z.string(),
		label: z.string().optional(),
		lead: z.string().optional(),
	}),
});

export const collections = { projects, posts, lab, opensource, services, pages };
