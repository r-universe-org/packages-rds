# packages-rds

Serializes JSON records into the `PACKAGES.rds` format used by CRAN-like repositories.

The RDS format is faster to parse for R clients than the text-based `PACKAGES` files.

```js
import { packagesRDS } from "@r-universe/packages-rds";

let data = [
	{ Package: "abc", Version: "1.0" },
	{ Package: "xyz", Version: "2.3" },
];

let buf = packagesRDS(data, { columns: ["Package", "Version"], compression: "gzip" });
```
