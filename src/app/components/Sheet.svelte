<script lang="ts">
  // Modal sheet: bottom sheet on phones, centered dialog on wide screens.
  // Uses <dialog> for focus trapping, Esc to close and inert background.
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';

  let {
    open = $bindable(false),
    title,
    wide = false,
    onclose,
    children,
    footer,
  }: { open?: boolean; title: string; wide?: boolean; onclose?: () => void; children: Snippet; footer?: Snippet } = $props();

  let dialog: HTMLDialogElement | undefined = $state();
  const id = `sheet-${Math.random().toString(36).slice(2)}`;

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  });

  function close() {
    open = false;
    onclose?.();
  }
</script>

<dialog
  bind:this={dialog}
  class="sheet"
  class:wide
  aria-labelledby={id}
  onclose={() => open && close()}
  onclick={(e) => e.target === dialog && close()}
>
  {#if open}
    <div class="panel">
      <header>
        <h2 {id}>{title}</h2>
        <button class="icon-btn" type="button" onclick={close} aria-label="Close"><Icon name="x" /></button>
      </header>
      <div class="body">{@render children()}</div>
      {#if footer}<footer>{@render footer()}</footer>{/if}
    </div>
  {/if}
</dialog>

<style>
  .sheet {
    padding: 0;
    border: 0;
    background: transparent;
    max-width: 100vw;
    max-height: 100dvh;
    margin: auto auto 0;
    width: 100%;
    color: var(--text);
  }
  .sheet::backdrop {
    background: rgb(8 12 10 / 0.45);
    backdrop-filter: blur(2px);
  }
  .panel {
    background: var(--surface);
    border-radius: var(--radius-l) var(--radius-l) 0 0;
    box-shadow: var(--shadow-3);
    max-height: 92dvh;
    display: flex;
    flex-direction: column;
    animation: up 220ms var(--ease);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 8px 6px 20px;
    border-bottom: 1px solid var(--border);
  }
  header h2 {
    font-size: 1.05rem;
  }
  .body {
    padding: 16px 20px;
    overflow: auto;
    overscroll-behavior: contain;
  }
  footer {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
    padding: 12px 20px calc(12px + var(--safe-b));
    border-top: 1px solid var(--border);
    background: var(--surface);
    border-radius: 0 0 var(--radius-l) var(--radius-l);
  }
  @keyframes up {
    from {
      transform: translateY(24px);
      opacity: 0;
    }
  }
  @media (min-width: 760px) {
    .sheet {
      margin: auto;
      width: min(560px, 92vw);
    }
    .sheet.wide {
      width: min(880px, 94vw);
    }
    .panel {
      border-radius: var(--radius-l);
      max-height: 86dvh;
    }
    footer {
      padding-bottom: 12px;
    }
  }
</style>
