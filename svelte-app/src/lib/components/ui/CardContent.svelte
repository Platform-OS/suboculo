<script>
  import { cn } from "$lib/utils.js";

  let className = "";
  export { className as class };
</script>

<div class={cn("p-6", className)} {...$$restProps}>
  <slot />
</div>
