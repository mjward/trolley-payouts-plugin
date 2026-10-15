// Worker pool whose width can shrink at runtime (adaptive on 429s).
export async function runPool(items, worker, ctl) {
  let i = 0, active = 0;
  return new Promise((resolve, reject) => {
    const pump = () => {
      if (i >= items.length && active === 0) return resolve();
      while (active < ctl.concurrency && i < items.length) {
        const item = items[i++]; active++;
        Promise.resolve(worker(item)).then(() => { active--; pump(); }, reject);
      }
    };
    pump();
  });
}

