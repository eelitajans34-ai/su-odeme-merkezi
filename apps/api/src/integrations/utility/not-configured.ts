import { UtilityNotConfiguredError, type WaterUtilityAdapter } from './types.js';

const fail = async (): Promise<never> => {
  throw new UtilityNotConfiguredError();
};

export const notConfiguredUtilityAdapter: WaterUtilityAdapter = {
  code: 'NONE',
  isSimulator: false,
  async testConnection() {
    return { ok: false, code: 'NOT_CONFIGURED', message: 'Su idaresi adaptörü tanımlı değil. Kurum dokümanı ve yetki bekleniyor.' };
  },
  queryAccount: fail,
  submitTopup: fail,
  getTopupStatus: fail,
  queryBills: fail,
  submitBillPayment: fail,
  getCollectionStatus: fail,
};
