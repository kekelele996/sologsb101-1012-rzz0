/**
 * 在账对账：布设班组侧（台站 / 仪器 / 安装日期）与台网中心侧（台阵状态 / 投运日期）
 * 按台站码逐站核对，对不上的单列。
 * 对账失败重试时只重读布设班组侧数据；台网中心下发的投运日期以现有值为准，不回退、不改写。
 */
import { db } from '@/utils/db';
import { isArrayOnBook, type SeisArray } from '@/types/array';
import type { SeisStation } from '@/types/station';
import type { Instrument } from '@/types/instrument';

/** 单个台站的对账结果 */
export interface ReconcileRow {
  station: SeisStation;
  /** 台网中心侧的台阵档案（缺失为 null） */
  array: SeisArray | null;
  /** 该台站登记的仪器台数（布设班组侧） */
  instrumentCount: number;
  /** 该台站最早仪器安装日期（无仪器为 null） */
  earliestInstallDate: string | null;
  /** 是否对上（在账） */
  onBook: boolean;
  /** 对不上的原因（对上时为空串） */
  reason: string;
}

export interface ReconcileResult {
  /** 对上的台站：台阵运行中且投运日期齐备，旗下仪器进在账与周期 */
  matched: ReconcileRow[];
  /** 对不上的台站：单列展示，待布设班组核对或台网中心补登 */
  unmatched: ReconcileRow[];
}

/** 按台站码逐站对账：布设班组侧台站 × 台网中心侧台阵状态与投运日期 */
export function reconcileByStationCode(
  stations: SeisStation[],
  arrays: SeisArray[],
  instruments: Instrument[]
): ReconcileResult {
  const rows: ReconcileRow[] = stations
    .map((station) => {
      const array = arrays.find((row) => row.id === station.arrayId) ?? null;
      const own = instruments.filter((instrument) => instrument.stationId === station.id);
      const installDates = own
        .map((instrument) => instrument.installDate)
        .filter(Boolean)
        .sort();
      let reason = '';
      if (!array) {
        reason = '台网中心未登记该台站所属台阵，请布设班组核对台站归属';
      } else if (array.state !== '运行中') {
        reason = `台阵${array.state}，台网中心尚未投运，仪器暂不进在账与周期`;
      } else if (!array.commissionDate) {
        reason = '台阵运行中但缺投运日期（升级未补出），待台网中心补登';
      }
      return {
        station,
        array,
        instrumentCount: own.length,
        earliestInstallDate: installDates[0] ?? null,
        onBook: reason === '' && isArrayOnBook(array),
        reason,
      };
    })
    .sort((a, b) => a.station.code.localeCompare(b.station.code, 'zh-Hans-CN'));
  return {
    matched: rows.filter((row) => row.onBook),
    unmatched: rows.filter((row) => !row.onBook),
  };
}

/**
 * 重试对账时只重读布设班组侧（台站 + 仪器）；
 * 台网中心侧（台阵状态 / 投运日期）沿用已下发值，绝不回退或改写。
 */
export async function reloadDeploymentSide(): Promise<{
  stations: SeisStation[];
  instruments: Instrument[];
}> {
  const [stations, instruments] = await Promise.all([db.stations.toArray(), db.instruments.toArray()]);
  return { stations, instruments };
}
