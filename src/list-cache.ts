/**
 * Last loaded lists, kept in memory for the browser tab. A page shows its cached list at once when it opens again, then
 * replaces it with the response of its normal request. Entries are keyed by page and settings revision.
 */
const lists=new Map<string,unknown>();
/** Returns the cached list for `key`, or undefined. */
export function cachedList<T>(key:string):T|undefined{return lists.get(key) as T|undefined;}
/** Stores the latest list for `key`. At most 50 lists are kept. */
export function rememberList(key:string,value:unknown){lists.delete(key);lists.set(key,value);if(lists.size>50)lists.delete(lists.keys().next().value!);}
/** Removes every cached list. Called when the Vault locks. */
export function clearListCache(){lists.clear();}
