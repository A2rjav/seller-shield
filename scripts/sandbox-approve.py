"""Approve a PayPal SANDBOX order as the sandbox test buyer (Playwright + local Chrome).

Usage (from seller-shield/):  python scripts/sandbox-approve.py <approve_url>
Reads SANDBOX_BUYER_EMAIL / SANDBOX_BUYER_PASSWORD from the environment or from .env. Never prints them.
Exit code 0 when PayPal redirected back to the return URL (order APPROVED), 1 otherwise.
A persistent browser profile in .data/buyer-profile (git-ignored) keeps the buyer signed in between runs.
"""
import os
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
PROFILE = ROOT / ".data" / "buyer-profile"
SANDBOX_HOSTS = ("www.sandbox.paypal.com",)


def load_env() -> dict:
    env = {}
    p = ROOT / ".env"
    if p.exists():
        for line in p.read_text(encoding="utf8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"')
    env.update({k: v for k, v in os.environ.items() if k.startswith("SANDBOX_BUYER_") and v})
    return env


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: python scripts/sandbox-approve.py <approve_url>")
        return 2
    url = sys.argv[1]
    if not any(f"://{h}/" in url for h in SANDBOX_HOSTS):
        print("refusing: the approve URL is not on the PayPal sandbox host")
        return 2
    env = load_env()
    email, password = env.get("SANDBOX_BUYER_EMAIL"), env.get("SANDBOX_BUYER_PASSWORD")
    if not email or not password:
        print("SANDBOX_BUYER_EMAIL / SANDBOX_BUYER_PASSWORD are not set")
        return 2
    return_host = re.escape(re.sub(r"^https?://", "", os.environ.get("APP_BASE_URL") or env.get("APP_BASE_URL") or "http://localhost:3000").split("/")[0])
    headless = os.environ.get("HEADLESS", "0") == "1"
    PROFILE.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(str(PROFILE), channel="chrome", headless=headless, viewport={"width": 1200, "height": 900})
        pg = ctx.pages[0] if ctx.pages else ctx.new_page()
        # PayPal redirects to the return URL once the order is approved. Nothing needs to be listening there (a local
        # run usually has no server, so the page load fails); the outgoing request to it is the signal.
        returned = []
        pg.on("request", lambda r: returned.append(1) if re.match(rf"https?://{return_host}(/|$|\?)", r.url) else None)
        try:
            pg.goto(url)
            pg.wait_for_timeout(4000)
            if pg.locator("#email").count() and pg.locator("#email").is_visible():
                pg.fill("#email", email)
                if pg.locator("#btnNext").count() and pg.locator("#btnNext").is_visible() and not pg.locator("#password").is_visible():
                    pg.click("#btnNext")
                    pg.wait_for_timeout(2000)
                pg.fill("#password", password)
                pg.locator('#btnLogin, button:has-text("Log In")').first.click()
                pg.wait_for_timeout(9000)
                print("signed in as the sandbox buyer")
            pay = pg.locator('button:has-text("Pay"), button:has-text("Continue"), button:has-text("Complete Purchase"), #payment-submit-btn')
            pay.last.wait_for(state="visible", timeout=30000)
            pay.last.click()
            for _ in range(90):
                if returned:
                    print("approved: PayPal redirected to the return URL")
                    return 0
                pg.wait_for_timeout(500)
            print("no redirect to the return URL within 45s")
            return 1
        except Exception as e:  # noqa: BLE001 - report and fail
            if returned:
                print("approved: PayPal redirected to the return URL")
                return 0
            msg = str(e).replace(email, "<buyer>").replace(password, "<secret>")
            print(f"approval failed at {pg.url.split('?')[0][:80]}: {msg[:300]}")
            return 1
        finally:
            ctx.close()


if __name__ == "__main__":
    sys.exit(main())
