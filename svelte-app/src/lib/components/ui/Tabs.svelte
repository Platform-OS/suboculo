<script>
  import { setContext } from "svelte";
  import { writable } from "svelte/store";

  export let value;

  const activeTab = writable(value);
  $: activeTab.set(value);

  setContext("tabs", { activeTab });
</script>

<div {...$$restProps}>
  <slot />
</div>
