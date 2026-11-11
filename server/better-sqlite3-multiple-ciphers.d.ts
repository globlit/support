/** The package types are not reachable through its `exports`. This declares the part of the API Support uses. */
declare module 'better-sqlite3-multiple-ciphers' {
 export default class Database {
  constructor(file:string);
  exec(sql:string):this;
  pragma(sql:string):unknown;
  prepare(sql:string):unknown;
  close():this;
 }
}
