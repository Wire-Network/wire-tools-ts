import "source-map-support/register"

import { AppLifecycle } from "./AppLifecycle.js"

new AppLifecycle(__dirname).start()
