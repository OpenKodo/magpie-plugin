# Changelog

All notable changes to this package. Versioned independently of the OpenKodo
gateway.

## 0.2.3

- First public release on npm as `openkodo`.
- Title the plugin **OpenKodo** through `magpie.name`, which is what magpie
  reads for a package's own row (the npm name must stay lowercase).

## 0.2.2

- Declare the provider icon on `auth`, which is where magpie reads it. 0.2.1
  set it on the config record, so the card kept the generic provider box.

## 0.2.1

- Show 5-hour, 7-day, and monthly windows together, each with its reset time.
- Add the OpenKodo provider icon.
- Format money in cents so floating-point noise never reaches the card.

## 0.1.1

- Show the per-model five-hour request window the account is closest to
  filling, instead of the plan-wide anti-abuse counter.

# Changelog

## 0.1.0

- Initial OpenKodo provider for OpenCode and magpie.
- API-key sign-in, live model catalog, credit balance, and 5-hour request window.
