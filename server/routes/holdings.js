'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { computeHoldings } = require('../lib/holdings');

// GET /api/v1/holdings
// Returns current unmatched buy positions grouped by ISIN.
// "Unmatched" = total bought - total sold, using simple FIFO for cost basis.
router.get('/', (req, res) => {
  res.json(computeHoldings(db));
});

module.exports = router;
