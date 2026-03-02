export interface SectionLoader {
  open: () => void;
  getLoadPromise: () => Promise<void> | undefined;
}

export async function ensureSectionLoaded(loader: SectionLoader): Promise<void> {
  loader.open();

  const loadPromise = loader.getLoadPromise();
  if (loadPromise) {
    await loadPromise;
  }
}
