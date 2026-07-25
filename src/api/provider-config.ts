/** Notifies an agent backend that provider or authentication data changed. */
export interface ProviderConfigChangeListener {
  markDirty(): void
}
