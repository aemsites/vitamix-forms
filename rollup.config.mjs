import path from 'path';
import fs from 'fs';
import replace from '@rollup/plugin-replace';
import { configDotenv } from 'dotenv';
import nodeResolve from '@rollup/plugin-node-resolve';

configDotenv();

/**
 * @param {string} srcpath 
 * @returns {string[]}
 */
function getDirectories(srcpath) {
  return fs.readdirSync(srcpath)
    .map(file => path.join(srcpath, file))
    .filter(path => fs.statSync(path).isDirectory());
}

const actions = getDirectories('src/actions').map(p => p.split('/')[2]);
console.log('\nrolling up actions: ', actions.join(', '));

export default actions.map(
  action => ({
    input: `src/actions/${action}/index.js`,
    output: {
      file: `dist/actions/${action}/index.js`,
      format: 'esm'
    },
    plugins: [
      replace({
        'process.env.DA_TOKEN': JSON.stringify(process.env.DA_TOKEN),
        preventAssignment: true
      })
    ]
  })
);