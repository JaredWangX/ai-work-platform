"""Publish a DNS-01 record for the workspace server."""
import os
import sys
import time
from urllib.parse import urlencode
from urllib.request import urlopen

domain = os.environ["SERVICE_DOMAIN"]
if os.environ.get("CERTBOT_DOMAIN", domain) != domain:
    sys.exit("Unexpected certificate domain")
mode = sys.argv[1]
record = {"domain": domain, "token": os.environ["SERVICE_DNS_TOKEN"]}
if mode == "address":
    record["myip"] = os.environ["SERVICE_IPV4"]
elif mode == "authorize":
    record["txt"] = os.environ["CERTBOT_VALIDATION"]
elif mode == "cleanup":
    record["txt"] = "null"
else:
    sys.exit("Unknown operation")
for delay in (2, 10, 30, 60):
    try:
        with urlopen("https://freemyip.com/update?" + urlencode(record), timeout=20) as response:
            if response.read().strip() == b"OK":
                break
    except OSError:
        pass
    time.sleep(delay)
else:
    sys.exit("DNS provider did not accept the update")
if mode == "authorize":
    time.sleep(95)
