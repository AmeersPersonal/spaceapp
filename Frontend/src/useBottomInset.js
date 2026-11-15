import { useEffect, useState } from "react";

// Tells CSS how much of the map's bottom edge the floating controls bar covers
// (--sx-bottom-inset on the .sx root), so the map attribution can sit above the
// bar on narrow screens instead of behind it. Use the returned function as the
// bar's `ref`.
export function useBottomInset() {
  const [bar, setBar] = useState(null);

  useEffect(() => {
    const root = bar?.parentElement;
    if (!root) return;
    const update = () =>
      root.style.setProperty("--sx-bottom-inset", `${root.clientHeight - bar.offsetTop}px`);
    const observer = new ResizeObserver(update);
    observer.observe(bar);
    observer.observe(root);
    update();
    return () => {
      observer.disconnect();
      root.style.removeProperty("--sx-bottom-inset");
    };
  }, [bar]);

  return setBar;
}

// Same idea for the top: the toolbar can wrap onto a second row on a narrow screen, so the
// details card under it follows its real bottom edge (--sx-top-inset on the .sx root).
export function useTopInset() {
  const [bar, setBar] = useState(null);

  useEffect(() => {
    const root = bar?.parentElement;
    if (!root) return;
    const update = () => root.style.setProperty("--sx-top-inset", `${bar.offsetTop + bar.offsetHeight + 8}px`);
    const observer = new ResizeObserver(update);
    observer.observe(bar);
    observer.observe(root);
    update();
    return () => {
      observer.disconnect();
      root.style.removeProperty("--sx-top-inset");
    };
  }, [bar]);

  return setBar;
}
