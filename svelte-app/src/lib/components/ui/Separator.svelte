<script>
  import { cn } from "$lib/utils.js";

  let className = "";
  export { className as class };
</script>

<div
  class={cn("shrink-0 bg-border h-[1px] w-full", className)}
  {...$$restProps}
/>
