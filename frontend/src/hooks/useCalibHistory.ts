/**
 * useCalibHistory：按仪器聚合历次标定、算灵敏度变化量与待标定天数。
 * 被标定记录台（/calibrations）与更换提醒页（/replacements）消费。
 *
 * 口径（与超期名单、按期标定率完全一致，见 utils/reconcile.ts）：
 * - 只有「运行中」台阵且投运日期齐备的在用 / 待标定仪器进在账、进标定周期；
 * - 建设中 / 停测台阵的仪器只显示安装事实，不算超期；
 * - 无标定记录时周期自投运日起算（投运晚于安装许多也不追溯安装期）。
 */
import { useCallback, useMemo } from 'react';
import { useSelector } from 'react-redux';
import { selectArrays, selectStations } from '@/stores/arraySlice';
import { selectInstruments } from '@/stores/instrumentSlice';
import { selectCalibrations } from '@/stores/calibrationSlice';
import { calibrateDueText, sensitivityDelta, type SensitivityDelta } from '@/types/calibration';
import { CALIBRATION_CYCLE_DAYS } from '@/types/instrument';
import type { Calibration, ResponseVerdict } from '@/types/calibration';
import type { Instrument } from '@/types/instrument';
import {
  buildInstrumentLedger,
  type CommissionInfo,
  type InstrumentLedgerEntry,
} from '@/utils/reconcile';

/** 单台仪器的标定历史聚合 */
export interface InstrumentCalibHistory {
  instrument: Instrument;
  stationCode: string;
  arrayId: string;
  arrayName: string;
  /** 历次标定（按日期降序） */
  calibrations: Calibration[];
  /** 最近一次标定 */
  latest: Calibration | null;
  /** 最近一次灵敏度相对上一次的变化 */
  delta: SensitivityDelta;
  /** 标定次数 */
  count: number;
  /** 距下次标定天数（负数为已超期；未进周期为 null） */
  dueInDays: number | null;
  /** 是否在账（运行中且投运日期齐备、未停用） */
  onLedger: boolean;
  /** 是否超期未标定（在账且超期） */
  overdue: boolean;
  /** 是否处于待标定状态 */
  pending: boolean;
  /** 所属台阵是否运行中 */
  running: boolean;
  /** 投运日期缺失、单列待核 */
  unresolved: boolean;
  /** 投运日期（YYYY-MM-DD 或 null） */
  commissionDate: string | null;
  /** 历次结论中最差的一次 */
  worstVerdict: ResponseVerdict;
  /** 灵敏度序列（由旧到新），供趋势展示 */
  trend: Array<{ date: string; sensitivity: number; selfNoise: number }>;
}

export interface UseCalibHistoryResult {
  histories: InstrumentCalibHistory[];
  historyOf: (instrumentId: string) => InstrumentCalibHistory | null;
  /** 超期名单：在账且超期（与按期标定率同一口径） */
  overdueHistories: InstrumentCalibHistory[];
  /** 待核：运行中但投运日期缺失，单列 */
  unresolvedHistories: InstrumentCalibHistory[];
  /** 建设中 / 停测：已安装但未进在账 */
  offLedgerHistories: InstrumentCalibHistory[];
  /** 灵敏度趋势：返回指定仪器的序列 */
  trendOf: (instrumentId: string) => Array<{ date: string; sensitivity: number; selfNoise: number }>;
}

const VERDICT_ORDER: Record<ResponseVerdict, number> = { 合格: 0, 待判定: 1, 不合格: 2 };

function toHistory(
  entry: InstrumentLedgerEntry,
  calibrations: Calibration[],
  stationCode: string
): InstrumentCalibHistory {
  const rows = calibrations
    .filter((calibration) => calibration.instrumentId === entry.instrument.id)
    .sort((a, b) => b.date.localeCompare(a.date));
  const latest = rows.length > 0 ? rows[0] : null;
  const previous = rows.length > 1 ? rows[1] : null;
  const delta = sensitivityDelta(latest?.sensitivity ?? 0, previous ? previous.sensitivity : null);
  const info: CommissionInfo = entry.info;
  const worstVerdict = rows.reduce<ResponseVerdict>((worst, row) => {
    return VERDICT_ORDER[row.responseVerdict] > VERDICT_ORDER[worst] ? row.responseVerdict : worst;
  }, '合格');
  return {
    instrument: entry.instrument,
    stationCode,
    arrayId: entry.array?.id ?? entry.station?.arrayId ?? '',
    arrayName: entry.array?.name ?? '未知台阵',
    calibrations: rows,
    latest,
    delta,
    count: rows.length,
    dueInDays: entry.onLedger ? entry.dueInDays : null,
    onLedger: entry.onLedger,
    overdue: entry.overdue,
    pending: entry.instrument.state === '待标定' || entry.overdue,
    running: info.running,
    unresolved: entry.unresolved,
    commissionDate: info.commissionDate,
    worstVerdict,
    trend: [...rows]
      .reverse()
      .map((row) => ({ date: row.date, sensitivity: row.sensitivity, selfNoise: row.selfNoise })),
  };
}

/**
 * 组合式 Hook：基于 Redux 中的台阵 / 台站 / 仪器 / 标定数据派生标定历史与超期提醒。
 */
export function useCalibHistory(): UseCalibHistoryResult {
  const arrays = useSelector(selectArrays);
  const stations = useSelector(selectStations);
  const instruments = useSelector(selectInstruments);
  const calibrations = useSelector(selectCalibrations);

  const histories = useMemo<InstrumentCalibHistory[]>(() => {
    const { entries } = buildInstrumentLedger(arrays, stations, instruments, calibrations);
    return entries
      .map((entry) => ({
        entry,
        code: stations.find((station) => station.id === entry.instrument.stationId)?.code ?? '未知台站',
      }))
      .map(({ entry, code }) => toHistory(entry, calibrations, code))
      .sort((a, b) => (a.dueInDays ?? Number.MAX_SAFE_INTEGER) - (b.dueInDays ?? Number.MAX_SAFE_INTEGER));
  }, [arrays, calibrations, instruments, stations]);

  const historyOf = useCallback(
    (instrumentId: string): InstrumentCalibHistory | null =>
      histories.find((history) => history.instrument.id === instrumentId) ?? null,
    [histories]
  );

  const overdueHistories = useMemo(
    () => histories.filter((history) => history.overdue),
    [histories]
  );

  const unresolvedHistories = useMemo(
    () => histories.filter((history) => history.unresolved),
    [histories]
  );

  const offLedgerHistories = useMemo(
    () => histories.filter((history) => !history.running),
    [histories]
  );

  const trendOf = useCallback(
    (instrumentId: string): Array<{ date: string; sensitivity: number; selfNoise: number }> =>
      histories.find((history) => history.instrument.id === instrumentId)?.trend ?? [],
    [histories]
  );

  return { histories, historyOf, overdueHistories, unresolvedHistories, offLedgerHistories, trendOf };
}

/** 标定周期说明文案，供页面提示 */
export const CALIBRATION_CYCLE_TEXT = `标定周期 ${CALIBRATION_CYCLE_DAYS} 天（约 1 年），仅运行中台阵在账仪器参评，自投运日起算，超期仪器在更换提醒页高亮`;

/** 待标定天数文案 */
export function dueText(history: InstrumentCalibHistory): string {
  if (history.dueInDays === null) {
    return history.unresolved ? '投运日期缺失，待核' : '未投运，暂不参评';
  }
  return calibrateDueText(history.dueInDays);
}
