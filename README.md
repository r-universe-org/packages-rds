# packages-rds

Serializes JSON records into the `PACKAGES.rds` format used by CRAN-like repositories.

The RDS format is faster to parse for R clients than the text-based `PACKAGES` files.

```js
import { packagesRDS } from "@r-universe/packages-rds";

let data = [
	{ Package: "abc", Version: "1.0" },
	{ Package: "xyz", Version: "2.3" },
];

let buf = packagesRDS(data, { columns: ["Package", "Version"], compress: "gzip" });
```

In servers, use `packagesRDSAsync()` instead, which returns a Promise and runs the
gzip/zstd compression on the libuv threadpool, so it does not block the event loop:

```js
import { packagesRDSAsync } from "@r-universe/packages-rds";

let buf = await packagesRDSAsync(data, { compress: "gzip" });
```
