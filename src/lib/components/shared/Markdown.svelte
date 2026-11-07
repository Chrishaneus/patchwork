<script lang="ts">
	import { Streamdown } from 'svelte-streamdown';
	import Code from 'svelte-streamdown/code';
	import { cn } from '#lib/utils.js';

	/**
	 * Agent output as Markdown (svelte-streamdown): headings, lists, tables, highlighted code with
	 * a copy button. It's untrusted text: raw HTML is shown as text, links are limited to
	 * http(s)/mailto, and remote images aren't loaded (they could track who reads the output).
	 */
	let {
		text,
		streaming = false,
		class: className = ''
	}: {
		text: string;
		/** True while the agent is still writing it: half-finished syntax is tidied up. */
		streaming?: boolean;
		class?: string;
	} = $props();
</script>

<div class={cn('min-w-0 text-sm [overflow-wrap:anywhere]', className)} data-testid="markdown">
	<Streamdown
		content={text}
		static={!streaming}
		baseTheme="shadcn"
		components={{ code: Code }}
		allowedLinkPrefixes={['https://', 'http://', 'mailto:']}
		allowedImagePrefixes={[]}
		codeBlockMaxHeight="24rem"
		tableMaxHeight="24rem"
	/>
</div>
