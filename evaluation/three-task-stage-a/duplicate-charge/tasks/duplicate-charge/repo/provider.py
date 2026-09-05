from dataclasses import dataclass


class ProviderTimeout(RuntimeError):
    pass


class ProviderUnavailable(RuntimeError):
    pass


@dataclass(frozen=True)
class Charge:
    charge_id: str
    payment_intent_id: str
    idempotency_key: str


class FakeProvider:
    """Provider fixture: one charge per idempotency key, not per payment intent."""

    def __init__(self):
        self.charges_by_key = {}
        self.requests = []
        self.behaviors = []

    def queue_behavior(self, behavior):
        self.behaviors.append(behavior)

    def charge(self, payment_intent_id, idempotency_key):
        behavior = self.behaviors.pop(0) if self.behaviors else "success"
        self.requests.append((payment_intent_id, idempotency_key, behavior))
        if behavior == "fail_before_accept":
            raise ProviderUnavailable("request rejected before acceptance")
        existing = self.charges_by_key.get(idempotency_key)
        if existing is None:
            existing = Charge(
                charge_id=f"ch-{len(self.charges_by_key) + 1}",
                payment_intent_id=payment_intent_id,
                idempotency_key=idempotency_key,
            )
            self.charges_by_key[idempotency_key] = existing
        if behavior == "success_then_timeout":
            raise ProviderTimeout("outcome unknown to caller")
        return existing

    @property
    def charges(self):
        return list(self.charges_by_key.values())
