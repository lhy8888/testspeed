# GeoIP reader fixtures

These small databases are test fixtures, not production geolocation data. No
fixture is embedded in the application or a release package. Files are unchanged
from the pinned upstream revisions below.

| File | Source revision | License | SHA-256 |
| --- | --- | --- | --- |
| `GeoIP2-City-Test.mmdb` | [MaxMind-DB `6a690a7`](https://github.com/maxmind/MaxMind-DB/blob/6a690a705bc6962c0025a32e94a8f0dc8f86418c/test-data/GeoIP2-City-Test.mmdb) | MIT, included in `LICENSE-MaxMind-MIT` | `ed972738e4e03a3e56e12041a6af4d91592249d110f7e4a647e5f2fa0e639c09` |
| `GeoIP2-ISP-Test.mmdb` | [MaxMind-DB `6a690a7`](https://github.com/maxmind/MaxMind-DB/blob/6a690a705bc6962c0025a32e94a8f0dc8f86418c/test-data/GeoIP2-ISP-Test.mmdb) | MIT, included in `LICENSE-MaxMind-MIT` | `45eb7af92e3c7f458a255af0479110c87a66841918cd2dffed834e59634c4abe` |
| `ipinfo_lite_sample.mmdb` | [IPinfo sample-database `764f865`](https://github.com/ipinfo/sample-database/blob/764f86502dda61a5247c7b2f5cdd66fcd190bab0/IPinfo%20Lite/ipinfo_lite_sample.mmdb) | IPinfo, CC BY 4.0, included in `LICENSE-IPinfo-CC-BY-4.0` | `0e42f0e5f87b44a1d10554c5b86dd5af22680899ed0e376f0b3aaaa7f10e7cdc` |

MaxMind's City fixture deliberately has different `country` and
`registered_country` values. The test verifies that the client's reported location
uses `country`, rather than the owner's registered country. The ISP fixture has
no location and therefore must not produce a fictitious city or country. IPinfo's
sample covers a limited set of addresses and verifies its flat location/ASN
schema and missing-record behavior.
