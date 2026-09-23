/**
 * `dme-flash` - everything needed to read, and eventually convert, an MSS54HP DME.
 *
 * The package is arranged in layers, and the layering is a safety property rather than a
 * stylistic one:
 *
 *   pure knowledge      regionMap, imageLayout, paband, calibrationImage, bootloaderImage
 *   pure construction   variant, blLoader, flashSequence, blReplace, telegrams, seedKey, ds2
 *   execution           transport, session          (injectable; a mock DME stands in for a car)
 *   hardware            webUsbFtdiTransport         (driven in tests by fakeUsbDevice)
 *
 * ## The write lock
 *
 * `HARDWARE_WRITE_ENABLED` in `writeLock.ts` is `false`, and two independent gates enforce it:
 * `telegrams.ts` refuses to BUILD a destructive telegram, and `transport.ts` refuses to SEND
 * one. So bytes obtained any other way - a literal, a log, a fixture - still cannot reach an ECU.
 *
 * Everything exported here that can read is fully usable today. Everything that could modify an
 * ECU can be planned, assembled and validated, but not transmitted.
 */

// --- what the ECU accepts, and where bytes live ---------------------------------------------
export * from './regionMap';
export * from './imageLayout';
export * from './regionTable.generated';

// --- BMW file formats and checksums ---------------------------------------------------------
export * from './paband';
export * from './calibrationImage';
export * from './spDaten';

// --- images -------------------------------------------------------------------------------
export * from './bootloaderImage';
export * from './variant';
export * from './programVariant';

// --- planning (pure; safe to run while locked) ----------------------------------------------
export * from './backupPlan';
export * from './fullSpaceRead';
export * from './flashSequence';
export * from './blLoader';
export * from './blReplace';
export * from './blExecute';
export * from './flashExecute';
export * from './fastEntry';

// --- protocol -------------------------------------------------------------------------------
export * from './ds2';
export * from './telegrams';
export * from './seedKey';

// --- execution ------------------------------------------------------------------------------
export * from './transport';
export * from './session';
export * from './mockDme';
export * from './practiceEcu';
export * from './webUsbFtdiTransport';

// --- the lock -------------------------------------------------------------------------------
export * from './writeLock';
