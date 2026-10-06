/**
 * 两侧对账与标定口径：
 * - 布设班组侧（本库）：台站、仪器安装位与安装日期
 * - 台网中心侧：台阵状态（建设中 / 运行中 / 停测）与投运日期
 * 两侧按台站码（trim + 大写）对账，对不上的单列；标定周期只对「运行中」台阵的仪器起算，
 * 超期名单与按期标定率共用本模块同一口径。
 */
import type { SeisArray } from '@/types/array';
import type { SeisStation } from '@/types/station';
import type { Instrument } from '@/types/instrument';
import type { Calibration } from '@/types/calibration';
import { CALIBRATION_CYCLE_DAYS } from '@/types/instrument';

/** 台站码归一化：去空白后转大写，作为两侧对账键 */
export function normalizeStationCode(code: string | null | undefined): string {
  return (code ?? '').trim().toUpperCase();
}

/** 是否合法 YYYY-MM-DD 且可解析 */
export function isValidDateText(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00`));
}

/** 标定周期基准日期（无标定记录时使用）：优先投运日，投运缺失时回退安装日 */
export function cycleBaseDate(commissionDate: string | null, installDate: string): string {
  return isValidDateText(commissionDate) ? commissionDate : installDate;
}

/**
 * 旧数据补投运日期：对缺少合法投运日期的台阵，按其下最早仪器安装日期回填。
 * 已持有合法投运日期的一律不动（不回退）；补不出的保持缺省，由在账口径单列待核。
 * 返回的 map 仅包含被补出的 arrayId。
 */
export function backfillCommissionDates(
  arrays: SeisArray[],
  stations: SeisStation[],
  instruments: Instrument[]
): Map<string, string> {
  const stationById = new Map(stations.map((station) => [station.id, station]));
  const earliest = new Map<string, string>();
  instruments.forEach((instrument) => {
    const station = stationById.get(instrument.stationId);
    if (!station || !isValidDateText(instrument.installDate)) return;
    const current = earliest.get(station.arrayId);
    if (!current || instrument.installDate < current) earliest.set(station.arrayId, instrument.installDate);
  });
  const filled = new Map<string, string>();
  arrays.forEach((array) => {
    if (isValidDateText(array.commissionDate)) return;
    const fallback = earliest.get(array.id);
    if (fallback) filled.set(array.id, fallback);
  });
  return filled;
}

/**
 * 距下次标定天数：以最近一次标定日期为准；无标定记录时从投运日起算，
 * 投运日晚于安装日许多也不追溯安装期（建设阶段不进周期）。
 * 正数为剩余天数，负数为已超期天数。
 */
export function daysUntilCommissionedDue(
  lastCalibrationDate: string | null,
  commissionDate: string | null,
  installDate: string,
  now: number = Date.now()
): number {
  const base = isValidDateText(lastCalibrationDate)
    ? (lastCalibrationDate as string)
    : cycleBaseDate(commissionDate, installDate);
  const baseTime = Date.parse(`${base}T00:00:00`);
  if (!Number.isFinite(baseTime)) return CALIBRATION_CYCLE_DAYS;
  return Math.round((baseTime + CALIBRATION_CYCLE_DAYS * 86400000 - now) / 86400000);
}

/* ------------------------------ 两侧对账 ------------------------------ */

/** 台网中心侧台站投运台账行（外部口径，仅按台站码对账） */
export interface NetworkStationRecord {
  /** 台站码（原始值，对账时按归一化后匹配） */
  code: string;
  /** 台网中心核定的所属台阵状态；缺省按「运行中」处理 */
  arrayState?: SeisArray['state'];
  /** 台网中心核定的投运日期 YYYY-MM-DD */
  commissionDate?: string;
  /** 台网中心侧原始行（用于回显） */
  raw?: unknown;
}

export interface StationReconcileItem {
  /** 对账键（归一化台站码） */
  key: string;
  station: SeisStation;
  array: SeisArray | null;
  network: NetworkStationRecord | null;
  /** 台网中心投运日期（合法日期文本，非法或缺失为 null） */
  commissionDate: string | null;
  /** 台阵是否处于运行中（本库与台网中心两侧状态一致才算运行中） */
  running: boolean;
  /** 对不上的原因；为空表示两侧匹配 */
  issue:
    | ''
    | 'missing-network'
    | 'missing-local'
    | 'state-mismatch'
    | 'invalid-commission-date';
}

export interface ReconcileResult {
  /** 两侧匹配成功 */
  matched: StationReconcileItem[];
  /** 对不上的，单列处理（不回退台网中心已核定的投运日期） */
  exceptions: StationReconcileItem[];
  /** 仅本库有（布设班组侧登记，台网中心无记录）——对账失败时只重试这一侧 */
  localOnly: StationReconcileItem[];
  /** 仅台网中心有（台网中心侧记录，本库无台站） */
  networkOnly: StationReconcileItem[];
  all: StationReconcileItem[];
}

/**
 * 按台站码对两侧台账：
 * - matched：台站码一致且本库台阵为运行中（台网中心若给了状态，需一致）
 * - exceptions：状态不一致或投运日期非法（仍保留台网中心原值，不回退）
 * - localOnly / networkOnly：台站码对不上，单列
 */
export function reconcileStations(
  arrays: SeisArray[],
  stations: SeisStation[],
  networkRecords: NetworkStationRecord[]
): ReconcileResult {
  const arrayById = new Map(arrays.map((array) => [array.id, array]));
  const networkByKey = new Map<string, NetworkStationRecord>();
  networkRecords.forEach((record) => {
    const key = normalizeStationCode(record.code);
    if (key) networkByKey.set(key, record);
  });
  const localByKey = new Map<string, { station: SeisStation; array: SeisArray | null }>();
  stations.forEach((station) => {
    const key = normalizeStationCode(station.code);
    if (key) localByKey.set(key, { station, array: arrayById.get(station.arrayId) ?? null });
  });

  const items: StationReconcileItem[] = [];

  localByKey.forEach(({ station, array }, key) => {
    const network = networkByKey.get(key) ?? null;
    const commissionDate = network && isValidDateText(network.commissionDate) ? network.commissionDate : null;
    let issue: StationReconcileItem['issue'] = '';
    if (!network) {
      issue = 'missing-network';
    } else if (network.arrayState && array && network.arrayState !== array.state) {
      issue = 'state-mismatch';
    } else if (network.commissionDate !== undefined && !isValidDateText(network.commissionDate)) {
      issue = 'invalid-commission-date';
    }
    // 是否进在账以本库台阵状态为准（状态不一致的异常项先不参评，待采用台网中心核定）
    const running = array?.state === '运行中' && issue !== 'state-mismatch';
    items.push({ key, station, array, network, commissionDate, running, issue });
  });

  networkByKey.forEach((network, key) => {
    if (localByKey.has(key)) return;
    const commissionDate = isValidDateText(network.commissionDate) ? network.commissionDate : null;
    items.push({
      key,
      station: null as unknown as SeisStation,
      array: null,
      network,
      commissionDate,
      running: network.arrayState === undefined || network.arrayState === '运行中',
      issue: 'missing-local',
    });
  });

  const matched = items.filter((item) => item.issue === '');
  const localOnly = items.filter((item) => item.issue === 'missing-network');
  const networkOnly = items.filter((item) => item.issue === 'missing-local');
  const exceptions = items.filter(
    (item) => item.issue === 'state-mismatch' || item.issue === 'invalid-commission-date'
  );

  return { matched, exceptions, localOnly, networkOnly, all: items };
}

/* --------------------------- 在账仪器与周期口径 --------------------------- */

/** 台站 id → 投运信息（由台阵/对账结果派生） */
export interface CommissionInfo {
  /** 台阵是否运行中；建设中 / 停测的仪器不进在账与周期 */
  running: boolean;
  /** 投运日期（合法值），周期首算基准；null 表示缺失，待核不参评 */
  commissionDate: string | null;
  /** 投运日期缺失（仅可能出现在旧数据升级补不出、或对账异常时） */
  missing: boolean;
}

export interface InstrumentLedgerEntry {
  instrument: Instrument;
  station: SeisStation | null;
  array: SeisArray | null;
  info: CommissionInfo;
  /** 是否计入在账台数：仅运行中台阵的在用 / 待标定仪器 */
  onLedger: boolean;
  /** 最近一次标定日期 */
  lastCalibrationDate: string | null;
  /** 距下次标定天数（仅在账仪器有效） */
  dueInDays: number;
  /** 是否超期（在账且超期） */
  overdue: boolean;
  /** 投运信息缺失、单列待核 */
  unresolved: boolean;
}

/**
 * 生成在账仪器台账：
 * - 建设中 / 停测台阵的仪器：已安装但不进在账、不进周期
 * - 运行中且投运日期缺失：单列待核，不进在账（避免再次冒进超期名单）
 * - 运行中且有投运日期：进在账，周期按统一口径计算
 */
export function buildInstrumentLedger(
  arrays: SeisArray[],
  stations: SeisStation[],
  instruments: Instrument[],
  calibrations: Calibration[],
  now: number = Date.now()
): { entries: InstrumentLedgerEntry[]; stationInfo: Map<string, CommissionInfo> } {
  const arrayById = new Map(arrays.map((array) => [array.id, array]));
  const stationById = new Map(stations.map((station) => [station.id, station]));

  const stationInfo = new Map<string, CommissionInfo>();
  stations.forEach((station) => {
    const array = arrayById.get(station.arrayId) ?? null;
    const commissionDate = isValidDateText(array?.commissionDate) ? (array?.commissionDate as string) : null;
    stationInfo.set(station.id, {
      running: array?.state === '运行中',
      commissionDate,
      missing: array?.state === '运行中' && !commissionDate,
    });
  });

  const lastCalib = new Map<string, Calibration>();
  calibrations.forEach((calibration) => {
    const current = lastCalib.get(calibration.instrumentId);
    if (!current || calibration.date > current.date) lastCalib.set(calibration.instrumentId, calibration);
  });

  const entries: InstrumentLedgerEntry[] = instruments.map((instrument) => {
    const station = stationById.get(instrument.stationId) ?? null;
    const array = station ? arrayById.get(station.arrayId) ?? null : null;
    const info =
      stationInfo.get(instrument.stationId) ??
      ({ running: false, commissionDate: null, missing: false } satisfies CommissionInfo);
    const last = lastCalib.get(instrument.id) ?? null;
    const unresolved = info.running && info.missing;
    const onLedger = info.running && !info.missing && instrument.state !== '已停用';
    const dueInDays = onLedger
      ? daysUntilCommissionedDue(last?.date ?? null, info.commissionDate, instrument.installDate, now)
      : Number.POSITIVE_INFINITY;
    return {
      instrument,
      station,
      array,
      info,
      onLedger,
      lastCalibrationDate: last?.date ?? null,
      dueInDays,
      overdue: onLedger && dueInDays < 0,
      unresolved,
    };
  });

  return { entries, stationInfo };
}

/** 在账台数（超期名单与按期标定率的同一分母口径） */
export function ledgerOnCount(entries: InstrumentLedgerEntry[]): number {
  return entries.filter((entry) => entry.onLedger).length;
}

/** 超期名单 */
export function ledgerOverdue(entries: InstrumentLedgerEntry[]): InstrumentLedgerEntry[] {
  return entries.filter((entry) => entry.overdue).sort((a, b) => a.dueInDays - b.dueInDays);
}

/**
 * 按期标定率（%）：在账且未超期 / 在账总数。
 * 与超期名单共用同一口径（buildInstrumentLedger 的 onLedger / overdue）。
 */
export function onScheduleRate(entries: InstrumentLedgerEntry[]): number {
  const onLedger = entries.filter((entry) => entry.onLedger);
  if (onLedger.length === 0) return 0;
  const overdueCount = onLedger.filter((entry) => entry.overdue).length;
  return Number((((onLedger.length - overdueCount) / onLedger.length) * 100).toFixed(1));
}
