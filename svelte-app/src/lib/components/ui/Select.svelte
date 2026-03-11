<script>
  import { cn } from "$lib/utils.js";

  export let value = "";
  export let options = [];
  let className = "";
  export { className as class };
</script>

<select
  bind:value
  class={cn(
    "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
    className
  )}
  on:change
  {...$$restProps}
>
  {#each options as option}
    <option value={option.value}>{option.label}</option>
  {/each}
</select>
