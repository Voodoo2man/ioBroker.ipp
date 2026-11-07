# ioBroker Internet Printing Protocol

![Network printer monitoring illustration](admin/ipp-banner.jpg)

[![NPM version](https://img.shields.io/npm/v/iobroker.ipp.svg)](https://www.npmjs.com/package/iobroker.ipp)
[![Downloads](https://img.shields.io/npm/dm/iobroker.ipp.svg)](https://www.npmjs.com/package/iobroker.ipp)


## ioBroker Internet Printing Protocol Adapter

The adapter polls configured network printers using the Internet Printing Protocol (IPP) and publishes read-only availability, printer state, toner or ink levels, and supported page counters. It uses `Get-Printer-Attributes` over IPP/2.0; device and firmware support varies, so optional attributes may not be reported by every printer. Compatibility depends on each printer’s IPP implementation; no particular device has been verified against this implementation.

Node.js 22 or newer, Admin 8.2.0 or newer, and js-controller 7.2.2 or newer are required.

## Configuration

Configure polling interval and request timeout in the **Basic configuration** tab. Add and manage printers in the **Printer configuration** tab using the Device Manager. Use its **Add printer**, **Edit**, and **Remove** actions; printer cards show the configured host, live connection state, and model when reported.

The Device Manager stores printers in the existing `native.printers` configuration array, so existing printer configurations remain compatible.

| Setting | Description |
| --- | --- |
| ID | Stable object-tree identifier; use 1-32 letters, digits, underscores, or hyphens. German umlauts are transliterated (`ä` to `ae`, `ö` to `oe`, `ü` to `ue`, `ß` to `ss`). The ID cannot be changed after creation because it determines the printer's state IDs. |
| Label | Display name for the printer. |
| Host | Printer hostname or IP address. |
| Port | IPP port; defaults to `631`. |
| IPP resource path | Printer resource path; defaults to `/ipp/print`. |
| Use TLS | Use IPPS over TLS. |
| Verify TLS certificate | Validate the printer's TLS certificate; disabled by default for self-signed printer certificates. |

The polling interval defaults to 60 seconds and is limited to 10 seconds through 24 hours. The request timeout defaults to 5000 ms and is limited to 500-30000 ms. The adapter only sends the read-only `Get-Printer-Attributes` operation; it does not submit print jobs or change printer settings. Configure only printers that expose an IPP endpoint at the selected host, port, and resource path.

Invalid printer rows are skipped with a warning that identifies the invalid fields. Debug logging reports configured field names and value types without printing configured values.

When a printer is switched off or temporarily unreachable, the adapter marks it offline without a warning-level log; connection and timeout details are available at debug level. IPP protocol, TLS, and configuration errors remain warnings.

## States

Each configured printer gets a device with `status`, `supplies`, `counters`, and `details` channels. Supplementary IPP attributes are created directly under `details` (for example, `details.printer_location`); attributes already represented by the canonical status, model, and counter states are not duplicated. The adapter requests all IPP attributes and creates states for returned values except explicitly excluded capabilities, verbose attribute families, and raw marker values; selected capability/default attributes are retained. Arrays and structured values are stored as JSON strings; scalar values keep their boolean, number, or string type. Unknown, non-excluded attributes are added automatically under `details`. `status.online` is always present; `status.model`, `status.message`, and numeric `status.state` are published when supported. The state value is `0` (`off`) while the printer is unreachable, and returns to the reported IPP state when it reconnects. Previously read measurements remain available while offline, and the last toner readings are retained if a poll does not include valid supply data. IPP marker levels are normalized to percentages using the reported low/high bounds and rounded to two decimal places. `pages_completed`, `impressions_completed`, and `media_sheets_completed` are created only when the printer reports them. Missing counter and detail values are cleared rather than replaced with zero during successful polls. Request details are not logged.

For supply reporting, the adapter combines `marker-names` with the corresponding entries in `marker-levels`, `marker-low-levels`, and `marker-high-levels`; `marker-types` is used when supplied. A supply is skipped if its name or any required numeric level/bound is missing, invalid, or out of range. Counters map from `pages-completed`, `impressions-completed`, and `media-sheets-completed` to `pages_completed`, `impressions_completed`, and `media_sheets_completed`. When reporting missing values, include the printer model and firmware, which of these IPP attributes the printer returns, and the raw values or state IDs that are absent.

[![Donate with PayPal](https://camo.githubusercontent.com/ef8c60305542390406855547e32850909812a73c4abada236de22a6dc88b313f/68747470733a2f2f7777772e70617970616c6f626a656374732e636f6d2f64655f44452f44452f692f62746e2f62746e5f646f6e61746543435f4c472e676966)](https://www.paypal.com/donate/?hosted_button_id=3RJQGSJNRSHUJ)

## Changelog
<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->
### 0.1.1 (2026-11-07)

- (Voodoo2man) Kept the last toner readings when printers temporarily omit supply data.

### 0.1.0 (2026-11-03)

- (Voodoo2man) Replaced the printer list with Device Manager configuration and split basic settings into a separate tab.

### 0.0.2 (2026-10-28)

- (Voodoo2man) Added Node.js 22 support and documented printer supply and counter attributes.

### 0.0.1 (2026-10-27)

- (Voodoo2man) initial release

Older release notes are available in [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

## License
MIT License

Copyright (c) 2026 Voodoo2man <Voodoo2man@outlook.de>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
