<script>
  import { cn } from "$lib/utils.js";

  export let variant = "default";
  export let disabled = false;
  let className = "";
  export { className as class };

  const variants = {
    default: "bg-primary text-primary-foreground hover:bg-primary/90",
    secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
    destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
    outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
    ghost: "hover:bg-accent hover:text-accent-foreground",
  };
</script>

<button
  class={cn(
    "inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
    "px-4 py-2",
    variants[variant],
    className
  )}
  {disabled}
  on:click
  {...$$restProps}
>
  <slot />
</button>
