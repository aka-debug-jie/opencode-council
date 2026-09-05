import unittest

from payment_worker import PaymentMessage, PaymentStore, PaymentWorker
from provider import FakeProvider


class IncidentReproductionTest(unittest.TestCase):
    def test_v1_timeout_then_v2_redelivery_does_not_double_charge(self):
        store, provider = PaymentStore(), FakeProvider()
        provider.queue_behavior("success_then_timeout")
        first = PaymentMessage("order-77", "pi-77", "req-A", "delivery-901")
        retry = PaymentMessage("order-77", "pi-77", "req-B", "delivery-902")
        self.assertFalse(PaymentWorker("v1", store, provider).handle(first))
        self.assertTrue(PaymentWorker("v2", store, provider).handle(retry))
        self.assertEqual(len(provider.charges), 1)
        self.assertEqual({charge.idempotency_key for charge in provider.charges}, {"pi-77"})
        self.assertEqual(store.rows["pi-77"]["status"], "charged")


if __name__ == "__main__":
    unittest.main()
