<script lang="ts">
  import { toasts } from '../state/toast.svelte';
  import Icon from './Icon.svelte';
</script>

<div class="toasts" role="status" aria-live="polite">
  {#each toasts.list as t (t.id)}
    <div class="toast {t.tone}">
      <Icon name={t.tone === 'error' ? 'alert' : t.tone === 'ok' ? 'check' : 'info'} size={18} />
      <span>{t.message}</span>
      {#if t.action}
        <button type="button" onclick={() => { t.action?.run(); toasts.dismiss(t.id); }}>{t.action.label}</button>
      {/if}
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed; z-index: 60; left: 50%; transform: translateX(-50%);
    bottom: calc(var(--nav-h) + 90px + var(--safe-b)); display: grid; gap: 8px; width: min(440px, calc(100vw - 24px));
  }
  .toast {
    display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-radius: var(--radius);
    background: var(--text); color: var(--bg); box-shadow: var(--shadow-2); font-size: 0.9rem; animation: in 200ms var(--ease);
  }
  .toast.error { background: var(--neg); color: #fff; }
  .toast span { flex: 1; }
  button { background: none; border: 0; color: inherit; font-weight: 700; text-decoration: underline; padding: 4px 6px; }
  @keyframes in { from { transform: translateY(10px); opacity: 0; } }
  @media (min-width: 960px) { .toasts { bottom: 24px; } }
</style>
