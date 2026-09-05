from dataclasses import dataclass


@dataclass(frozen=True)
class Snapshot:
    permissions: frozenset
    generation: int


class PermissionStore:
    def __init__(self):
        self.rows = {}

    def set_permissions(self, tenant_id, user_id, permissions):
        key = (tenant_id, user_id)
        previous = self.rows.get(key, Snapshot(frozenset(), 0))
        snapshot = Snapshot(frozenset(permissions), previous.generation + 1)
        self.rows[key] = snapshot
        return snapshot

    def snapshot(self, tenant_id, user_id):
        return self.rows.get((tenant_id, user_id), Snapshot(frozenset(), 0))
