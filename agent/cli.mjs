#!/usr/bin/env node
import { cli } from './runtime.mjs';
import { product } from './product.mjs';
await cli(product);
