// The one clock behind every relative time on the War Room. It is 0 on the server and on the first client render, so both produce the same
// markup (the view functions show an absolute UTC time for a clock of 0); it is set to the real time on mount and ticks after that.
export function useNowMs(intervalMs = 30_000): Ref<number> {
  const nowMs = ref(0);
  let clock: ReturnType<typeof setInterval> | undefined;
  onMounted(() => {
    nowMs.value = Date.now();
    clock = setInterval(() => (nowMs.value = Date.now()), intervalMs);
  });
  onBeforeUnmount(() => clearInterval(clock));
  return nowMs;
}
