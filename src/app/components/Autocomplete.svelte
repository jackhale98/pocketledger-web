<script lang="ts">
  // Combobox input with a filtered suggestion list (ARIA 1.2 combobox pattern).
  let {
    value = $bindable(''),
    options,
    label,
    placeholder = '',
    id,
    invalid = false,
    inputmode,
    onpick,
    max = 8,
  }: {
    value?: string;
    options: string[];
    label: string;
    placeholder?: string;
    id: string;
    invalid?: boolean;
    inputmode?: 'text' | 'decimal';
    onpick?: (v: string) => void;
    max?: number;
  } = $props();

  let open = $state(false);
  let active = $state(-1);

  const matches = $derived.by(() => {
    const q = value.trim().toLowerCase();
    if (!q) return options.slice(0, max);
    const starts: string[] = [];
    const contains: string[] = [];
    // Fuzzy-ish for accounts: "ex:foo" matches "expenses:food".
    const parts = q.split(':');
    for (const o of options) {
      const l = o.toLowerCase();
      if (l === q) continue;
      if (l.startsWith(q)) starts.push(o);
      else if (l.includes(q)) contains.push(o);
      else if (parts.length > 1) {
        const segs = l.split(':');
        let si = 0;
        if (parts.every((p) => { while (si < segs.length && !segs[si]!.startsWith(p)) si++; return si++ < segs.length; })) contains.push(o);
      }
      if (starts.length >= max) break;
    }
    return [...starts, ...contains].slice(0, max);
  });

  function pick(v: string) {
    value = v;
    open = false;
    active = -1;
    onpick?.(v);
  }
  function key(e: KeyboardEvent) {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) open = true;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(matches.length - 1, active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(-1, active - 1); }
    else if ((e.key === 'Enter' || e.key === 'Tab') && open && active >= 0 && matches[active]) { if (e.key === 'Enter') e.preventDefault(); pick(matches[active]!); }
    else if (e.key === 'Escape' && open) { e.stopPropagation(); e.preventDefault(); open = false; }
  }
</script>

<div class="ac">
  <input
    {id}
    class="input"
    type="text"
    role="combobox"
    aria-label={label}
    aria-expanded={open && matches.length > 0}
    aria-controls="{id}-list"
    aria-autocomplete="list"
    aria-activedescendant={active >= 0 ? `${id}-o${active}` : undefined}
    aria-invalid={invalid}
    autocomplete="off"
    autocapitalize="off"
    spellcheck="false"
    {inputmode}
    {placeholder}
    bind:value
    onfocus={() => (open = true)}
    oninput={() => { open = true; active = -1; }}
    onblur={() => setTimeout(() => (open = false), 120)}
    onkeydown={key}
  />
  {#if open && matches.length > 0}
    <ul id="{id}-list" role="listbox" aria-label="{label} suggestions">
      {#each matches as m, i (m)}
        <li id="{id}-o{i}" role="option" aria-selected={i === active} onpointerdown={(e) => { e.preventDefault(); pick(m); }}>{m}</li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .ac { position: relative; }
  ul {
    position: absolute; z-index: 30; left: 0; right: 0; top: calc(100% + 4px); margin: 0; padding: 4px; list-style: none;
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-s); box-shadow: var(--shadow-2);
    max-height: 240px; overflow: auto;
  }
  li { padding: 9px 10px; border-radius: 6px; font-size: 0.92rem; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  li:hover, li[aria-selected='true'] { background: var(--accent-soft); color: var(--accent-strong); }
</style>
