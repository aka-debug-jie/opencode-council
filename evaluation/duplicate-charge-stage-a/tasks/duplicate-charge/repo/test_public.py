import unittest

from payment_worker import PaymentMessage, PaymentStore, PaymentWorker
from provider import FakeProvider


class PublicBehaviorTest(unittest.TestCase):
    def message(self, delivery_id="delivery-1", intent="pi-1", order="order-1"):
        return PaymentMessage(order, intent, "request-1", delivery_id)

    def test_v2_redelivery_reuses_provider_effect(self):
        store, provider = PaymentStore(), FakeProvider()
        provider.queue_behavior("success_then_timeout")
        worker = PaymentWorker("v2", store, provider)
        self.assertFalse(worker.handle(self.message("delivery-1")))
        self.assertTrue(worker.handle(self.message("delivery-2")))
        self.assertEqual(len(provider.charges), 1)

    def test_v1_single_successful_delivery(self):
        store, provider = PaymentStore(), FakeProvider()
        self.assertTrue(PaymentWorker("v1", store, provider).handle(self.message()))
        self.assertEqual(len(provider.charges), 1)


if __name__ == "__main__":
    unittest.main()
