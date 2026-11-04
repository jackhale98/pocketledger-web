<script lang="ts">
  import type { MixedAmount } from '$lib/contracts/amount';
  import { formatAmount, isNegative, isZero, sumMixed } from '$lib/engine/decimal';

  let {
    value,
    color = false,
    invert = false,
    signed = false,
    precision,
    zero = '0',
  }: { value: MixedAmount; color?: boolean; invert?: boolean; signed?: boolean; precision?: number; zero?: string } = $props();

  // One line per commodity, as hledger displays it (lots with different costs are summed).
  const shown = $derived(sumMixed(value).filter((a) => !isZero(a.quantity)));
</script>

<span class="money amount">
  {#if shown.length === 0}
    <span class="muted">{zero}</span>
  {:else}
    {#each shown as a, i (i)}
      {@const neg = isNegative(a.quantity) !== invert}
      <span class:pos={color && !neg} class:neg={color && neg}
        >{formatAmount(invert ? { ...a, quantity: a.quantity.startsWith('-') ? a.quantity.slice(1) : '-' + a.quantity } : a, {
          signed,
          ...(precision != null ? { precision } : {}),
        })}</span
      >{#if i < shown.length - 1}<br />{/if}
    {/each}
  {/if}
</span>

<style>
  .money {
    white-space: nowrap;
    text-align: right;
    display: inline-block;
  }
</style>
