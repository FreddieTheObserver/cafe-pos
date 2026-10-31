export const createIdleTimer = (ms: number, onIdle: () => void) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => clearTimeout(timer);
  const reset = () => {
    stop();
    timer = setTimeout(onIdle, ms);
  };
  return { reset, stop };
};
