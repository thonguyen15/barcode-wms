export const SAMPLE_TOKEN = "5b1f0c9e7a2d48e6b3a0f1c7d9e2b4a6085f3c1d7e9b2a4f6d8c0e1b3a5f7d9";

export const SAMPLE_ITEMS = {
  japanese: {
    mvd: "MVD-001234",
    serial_clean: "SN-AB12CD34EF56",
    serial_raw: "S/N: SN-AB12CD34EF56",
    name: "シャープ 加湿空気清浄機 プラズマクラスター KC-J50",
    qrText: SAMPLE_TOKEN,
  },
  latin: {
    mvd: "MVD-099",
    serial_clean: "7YU-AT&T.P",
    serial_raw: "7YU-AT&T.P",
    name: "Dyson V15 Detect Absolute",
    qrText: "a3c5e7f9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a5",
  },
  mixed: {
    mvd: "MVD-042",
    serial_clean: "WC-2581473690",
    serial_raw: "シリアル番号 WC-2581473690",
    name: "ダイソン V15 ペット コードレス 掃除機 (2026年製)",
    qrText: "f0e1d2c3b4a5968778695a4b3c2d1e0fa1b2c3d4e5f60718293a4b5c6d7e8f90a1b",
  },
  long: {
    mvd: "MVD-100",
    serial_clean: "XK-9Z8Y7X6W5V4U3T2S1RQPO_NML",
    serial_raw: "型番 XK-9Z8Y7X6W5V4U3T2S1RQPO_NML-REV.A",
    name: "パナソニック ナショナル 冷蔵庫 6ドア 500L class NR-F502HPV-W ガラス扉 2019年製 兵庫県尼崎市 引取りのみ・配送不可・エレベーターなし3階",
    qrText: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  },
  fallback: {
    mvd: "MVD-001",
    serial_clean: "",
    serial_raw: "畑 📦 Ω",
    name: "トースター 縦置き 﨑㈱ ① №",
    qrText: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    outsideAtlas: true,
  },
  multiline: {
    mvd: "MVD-077",
    serial_clean: "AJ-4XK2-99Q",
    serial_raw: "AJ-4XK2-99Q",
    name: "Nintendo Switch Lite\nツインスティック\n保証書なし",
    qrText: "9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcba",
  },
};
