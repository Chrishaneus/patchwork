<script lang="ts">
	import * as Card from '#lib/components/ui/card/index.js';

	let { message }: { message: string } = $props();
</script>

<Card.Root class="border-dashed">
	<Card.Content class="py-10 text-center text-sm text-muted-foreground">{message}</Card.Content>
</Card.Root>
