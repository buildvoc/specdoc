'use strict'
const fs = require('fs')
const path = require('path')
const here = __dirname
for (const file of ['repo-add-hook.js', 'merge-specs-hook.js']) {
  const full = path.join(here, file)
  if (fs.existsSync(full)) require(full)
}
