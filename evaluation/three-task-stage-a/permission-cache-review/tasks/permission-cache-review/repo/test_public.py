import unittest

from auth_cache import PermissionCache
from auth_store import PermissionStore


class PublicPatchTest(unittest.TestCase):
    def test_refreshes_an_uncached_user(self):
        store = PermissionStore()
        store.set_permissions("tenant-a", "user-a", {"read"})
        cache = PermissionCache(store)
        self.assertEqual(cache.get_or_refresh("tenant-a", "user-a"), {"read"})

    def test_invalidation_removes_a_stale_entry(self):
        store = PermissionStore()
        first = store.set_permissions("tenant-a", "user-a", {"read", "write"})
        cache = PermissionCache(store)
        self.assertEqual(cache.get_or_refresh("tenant-a", "user-a"), first.permissions)
        revoked = store.set_permissions("tenant-a", "user-a", {"read"})
        cache.invalidate("tenant-a", "user-a", revoked.generation)
        self.assertEqual(cache.get_or_refresh("tenant-a", "user-a"), {"read"})

    def test_older_snapshot_does_not_replace_a_newer_present_entry(self):
        store = PermissionStore()
        older = store.set_permissions("tenant-a", "user-a", {"read"})
        newer = store.set_permissions("tenant-a", "user-a", {"admin"})
        cache = PermissionCache(store)
        cache.refresh_from_snapshot("tenant-a", "user-a", newer)
        self.assertFalse(cache.refresh_from_snapshot("tenant-a", "user-a", older))
        self.assertEqual(cache.get_or_refresh("tenant-a", "user-a"), {"admin"})


if __name__ == "__main__":
    unittest.main()
