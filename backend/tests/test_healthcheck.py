from fastapi.testclient import TestClient

from nexaquill_api.app import app


client = TestClient(app)


def test_healthcheck_route_returns_ok() -> None:
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
