from dataclasses import dataclass

from provider import ProviderTimeout, ProviderUnavailable


@dataclass(frozen=True)
class PaymentMessage:
    order_id: str
    payment_intent_id: str
    request_id: str
    delivery_id: str


class PaymentStore:
    def __init__(self):
        self.rows = {}

    def begin(self, message, provider_key):
        self.rows.setdefault(message.payment_intent_id, {
            "order_id": message.order_id,
            "status": "pending",
            "provider_key": provider_key,
            "charge_id": None,
        })
        return self.rows[message.payment_intent_id]

    def mark_charged(self, payment_intent_id, charge):
        row = self.rows[payment_intent_id]
        row["status"] = "charged"
        row["charge_id"] = charge.charge_id


class PaymentWorker:
    def __init__(self, protocol, store, provider):
        self.protocol = protocol
        self.store = store
        self.provider = provider

    def provider_key(self, message):
        # Legacy workers used a queue-delivery identity. New workers use the
        # payment intent, so a rolling deployment can change keys on redelivery.
        if self.protocol == "v1":
            return message.delivery_id
        return message.payment_intent_id

    def handle(self, message):
        key = self.provider_key(message)
        row = self.store.begin(message, key)
        if row["status"] == "charged":
            return True
        try:
            charge = self.provider.charge(message.payment_intent_id, key)
        except (ProviderTimeout, ProviderUnavailable):
            return False
        self.store.mark_charged(message.payment_intent_id, charge)
        return True
