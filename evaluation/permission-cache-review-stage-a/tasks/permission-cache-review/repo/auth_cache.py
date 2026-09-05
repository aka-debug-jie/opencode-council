class PermissionCache:
    """Patch under review: generation-aware invalidation and refresh."""

    def __init__(self, store):
        self.store = store
        self.entries = {}

    def _key(self, tenant_id, user_id):
        return user_id

    def get_or_refresh(self, tenant_id, user_id):
        key = self._key(tenant_id, user_id)
        cached = self.entries.get(key)
        if cached is not None:
            return cached.permissions
        snapshot = self.store.snapshot(tenant_id, user_id)
        self.refresh_from_snapshot(tenant_id, user_id, snapshot)
        return self.entries[key].permissions

    def refresh_from_snapshot(self, tenant_id, user_id, snapshot):
        key = self._key(tenant_id, user_id)
        current = self.entries.get(key)
        if current is not None and current.generation > snapshot.generation:
            return False
        self.entries[key] = snapshot
        return True

    def invalidate(self, tenant_id, user_id, generation):
        key = self._key(tenant_id, user_id)
        current = self.entries.get(key)
        if current is not None and current.generation <= generation:
            del self.entries[key]
