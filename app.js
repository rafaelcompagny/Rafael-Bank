import { watchAuth, logoutUser } from "./auth.js";
import {
  getUserProfile,
  updateUserProfile,
  getGlobalMarket,
  setGlobalMarket
} from "./db.js";
import { db } from "./firebase.js";
import {
  collection,
  getDocs,
  addDoc,
  onSnapshot,
  doc,
  getDoc,
  setDoc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const page = document.body.dataset.page;
let cryptoChart = null;
let historyPage = 1;
const HISTORY_PER_PAGE = 10;
let currentAdminUid = null;
let currentLeaderboardType = "wealth";
const MAX_OFFLINE_PASSIVE_MS = 2 * 60 * 60 * 1000; // 2 heures
let currentUserUid = null;

/* ================= HELPE50RS ================= */


function getPlayerWealthLevel(profile) {
  const wealth = getUserNetWorth(profile);

  if (wealth >= 1_000_000_000) return 6;
  if (wealth >= 100_000_000) return 5;
  if (wealth >= 10_000_000) return 4;
  if (wealth >= 1_000_000) return 3;
  if (wealth >= 100_000) return 2;
  return 1;
}

function getInflationMultiplier(profile) {
  const level = getPlayerWealthLevel(profile);

  const multipliers = {
    1: 1,
    2: 1.25,
    3: 1.75,
    4: 2,
    5: 2.5,
    6: 3
  };

  return multipliers[level] || 1;
}

function getDynamicBoostPrice(profile) {
  return Math.round(1000 * getInflationMultiplier(profile));
}

function getDynamicLoanAmounts(profile) {
  const level = getPlayerWealthLevel(profile);

  const loansByLevel = {
    1: [500, 2000, 10000],
    2: [10000, 50000, 100000],
    3: [100000, 500000, 1000000],
    4: [1000000, 5000000, 10000000],
    5: [10000000, 50000000, 100000000],
    6: [100000000, 500000000, 1000000000]
  };

  return loansByLevel[level] || loansByLevel[1];
}

function applyUserTheme(profile) {
  document.body.classList.remove(
    "theme-pink",
    "theme-purple",
    "theme-gold",
    "theme-red",
    "theme-white"
  );

  const theme = profile.shop?.activeTheme;

  if (theme && theme !== "default") {
    document.body.classList.add(`theme-${theme}`);
  }
}

function getLevelFromXp(xp = 0) {
  let level = 1;
  let required = 1000;
  let remainingXp = xp;

  while (remainingXp >= required) {
    remainingXp -= required;
    level++;
    required = Math.floor(required * 1.35);
  }

  return {
    level,
    currentXp: remainingXp,
    requiredXp: required,
    percent: Math.min(100, (remainingXp / required) * 100)
  };
}

function getLevelReward(level) {
  if (level <= 1) return 0;

  // Récompense progressive
  return Math.round(1000 * Math.pow(1.45, level - 2));
}

function addXp(profile, amount, reason = "Action", showXpToast = true) {
  const oldLevel = getLevelFromXp(profile.xp || 0).level;

  profile.xp = Number(profile.xp || 0) + amount;

  const newLevel = getLevelFromXp(profile.xp || 0).level;

  profile.history = profile.history || [];
  profile.accounts = profile.accounts || { Principal: 0 };

  const activeAccount = profile.activeAccount || "Principal";

  profile.history.unshift(`XP gagné : +${amount} XP (${reason})`);

  // ✅ Toast XP (seulement si demandé)
  if (showXpToast) {
    showToast(`✨ +${amount} XP (${reason})`, "xp");
  }

  // 🎉 LEVEL UP
  if (newLevel > oldLevel) {
    let totalReward = 0;

    for (let lvl = oldLevel + 1; lvl <= newLevel; lvl++) {
      totalReward += getLevelReward(lvl);
    }

    profile.accounts[activeAccount] =
      (profile.accounts[activeAccount] || 0) + totalReward;

    profile.history.unshift(
      `Niveau ${newLevel} atteint (+${formatMoney(totalReward)})`
    );

    showToast(
      `⭐ Niveau ${newLevel} ! +${formatMoney(totalReward)}`,
      "level"
    );
  }
}

async function getLatestNewsId() {
  const history = await getNewsHistory();
  return history.length ? history[0].id : null;
}

async function checkUnreadNews(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

  const latestNewsId = await getLatestNewsId();
  const dot = document.getElementById("newsUnreadDot");

  if (!dot || !latestNewsId) return;

  const lastReadNewsId = profile.lastReadNewsId || null;

  if (lastReadNewsId !== latestNewsId) {
    dot.style.display = "block";
  } else {
    dot.style.display = "none";
  }
}

async function markNewsAsRead(uid) {
  const latestNewsId = await getLatestNewsId();
  if (!latestNewsId) return;

  await updateUserProfile(uid, {
    lastReadNewsId: latestNewsId
  });

  const dot = document.getElementById("newsUnreadDot");
  if (dot) dot.style.display = "none";
}

function getBadgeById(id) {
  return BADGES.find(b => b.id === id);
}

function getRarityLabel(rarity) {
  if (rarity === "common") return "Commun";
  if (rarity === "rare") return "Rare";
  if (rarity === "epic") return "Épique";
  if (rarity === "legendary") return "Légendaire";
  return "Badge";
}

function renderBadgeCard(badge, unlocked = true) {
  if (!badge) return "";

  return `
    <div class="badge-card ${badge.rarity || "common"} ${unlocked ? "" : "locked"}">
      <div class="badge-card-icon">${unlocked ? badge.icon : "🔒"}</div>
      <div>
        <h3>${escapeHtml(badge.name)}</h3>
        <p class="small">${escapeHtml(badge.desc)}</p>
        <span class="badge-rarity">${getRarityLabel(badge.rarity)}</span>
      </div>
    </div>
  `;
}

function formatMoney(value) {
  const n = Number(value || 0);
  const abs = Math.abs(n);

  if (abs >= 1_000_000_000) {
    return (n / 1_000_000_000).toLocaleString("fr-FR", {
      maximumFractionDigits: 2
    }) + " Md€";
  }

  if (abs >= 1_000_000) {
    return (n / 1_000_000).toLocaleString("fr-FR", {
      maximumFractionDigits: 2
    }) + " M€";
  }

  if (abs >= 100_000) {
    return (n / 1_000).toLocaleString("fr-FR", {
      maximumFractionDigits: 1
    }) + " k€";
  }

  return n.toLocaleString("fr-FR", {
    maximumFractionDigits: 2
  }) + " €";
}

function getTotalPassiveIncome(profile) {
  profile.investments = profile.investments || {};

  return INVESTMENTS.reduce((total, inv) => {
    const qty = profile.investments[inv.id] || 0;
    return total + qty * inv.incomePerSecond;
  }, 0);
}

function getNextUpgrade(level) {
  const upgrades = {
    1: { cost: 500, value: 10, nextLevel: 2 },
    2: { cost: 10000, value: 50, nextLevel: 3 },
    3: { cost: 100000, value: 250, nextLevel: 4 },
    4: { cost: 1000000, value: 1000, nextLevel: 5 },
    5: { cost: 100000000, value: 10000, nextLevel: 6 },
  };
  return upgrades[level] || null;
}

function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function ensureAdminOwnsEverything(profile) {
  if (!profile?.isAdmin) return profile;

  profile.shop = profile.shop || {};
  profile.card = profile.card || { blocked: false, revealed: false, type: "black" };

  profile.shop.autoClicker = true;
  profile.shop.autoClickerEnabled = true;
  profile.shop.permanentMultiplier = Math.max(profile.shop.permanentMultiplier || 1, 10);
  profile.shop.ownsGoldCard = true;
  profile.shop.ownsBlackCard = true;
  profile.shop.visualPack = true;

  if (!profile.card.type || profile.card.type === "classic") {
    profile.card.type = "black";
  }

  return profile;
}

function byIdOrLegacy(id, legacySelector) {
  return document.getElementById(id) || (legacySelector ? document.querySelector(legacySelector) : null);
}

async function getAllUsers() {
  const snap = await getDocs(collection(db, "users"));
  return snap.docs.map(docSnap => ({
    uid: docSnap.id,
    ...docSnap.data()
  }));
}

function updateAdminNavVisibility(profile) {
  const adminNavLink = document.getElementById("adminNavLink");
  if (!adminNavLink) return;
  adminNavLink.style.display = profile?.isAdmin ? "block" : "none";
}

function bindLogout() {
  const logoutBtn = document.getElementById("logoutBtn");
  if (!logoutBtn) return;

  logoutBtn.onclick = async () => {
    await logoutUser();
    window.location.href = "index.html";
  };
}

/* ================ INVESTISSEMENTS ================================*/

const INVESTMENTS = [
  {
    id: "garage",
    name: "Garage auto",
    cost: 50000,
    incomePerSecond: 50,
    emoji: "🚗"
  },
  {
    id: "restaurant",
    name: "Restaurant",
    cost: 200000,
    incomePerSecond: 250,
    emoji: "🍽️"
  },
  {
    id: "startup",
    name: "Startup tech",
    cost: 1000000,
    incomePerSecond: 1500,
    emoji: "💻"
  },
  {
    id: "realestate",
    name: "Immeuble locatif",
    cost: 5000000,
    incomePerSecond: 10000,
    emoji: "🏢"
  },
  {
    id: "privatebank",
    name: "Banque privée",
    cost: 10000000,
    incomePerSecond: 15000,
    emoji: "🏦"
  }
];

const DAILY_REWARDS = [
  { type: "money", value: 250, label: "250 €" },
  { type: "money", value: 1000, label: "1 000 €" },
  { type: "money", value: 10000, label: "10 000 €" },
  { type: "boost", durationMs: 30 * 1000, label: "Boost x2 pendant 30 sec" },
  { type: "crypto", asset: "BTC", quantity: 0.0001, label: "0.0001 BTC" },
  { type: "crypto", asset: "ETH", quantity: 0.002, label: "0.002 ETH" }
];

function getRandomDailyReward() {
  return DAILY_REWARDS[Math.floor(Math.random() * DAILY_REWARDS.length)];
}

/* ================= HOME ================= */

async function renderHome(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;
  applyUserTheme(profile);

  ensureAdminOwnsEverything(profile);
  document.body.classList.toggle("visual-premium", !!profile.shop?.visualPack || !!profile.isAdmin);

  updateAdminNavVisibility(profile);

  const balanceEl = document.getElementById("balance");
  const welcomeEl = document.getElementById("welcomeUser");
  const historyEl = document.getElementById("history");
  const clickLevelText = document.getElementById("clickLevelText");
  const clickUpgradeInfo = document.getElementById("clickUpgradeInfo");
  const boostInfo = document.getElementById("boostInfo");
  const loanInfo = document.getElementById("loanInfo");
  const loanList = document.getElementById("loanList");
  const loanTimer = document.getElementById("loanTimer");
  const accountsList = document.getElementById("accountsList");
  const adminAddMoneyBtn = document.getElementById("adminAddMoneyBtn");

  const cardOwnerName = document.getElementById("cardOwnerName");
  const maskedCardNumber = document.getElementById("maskedCardNumber");
  const maskedExpiry = document.getElementById("maskedExpiry");
  const maskedCvv = document.getElementById("maskedCvv");
  const cardIban = document.getElementById("cardIban");
  const cardStatusText = document.getElementById("cardStatusText");
  const cardFront = document.getElementById("cardFront");
  const cardBack = document.getElementById("cardBack");
  const cardTypeSelect = document.getElementById("cardTypeSelect");

  const activeAccount = profile.activeAccount || "Principal";
  const accounts = profile.accounts || { Principal: 0 };
  const balance = accounts[activeAccount] ?? 0;
  const history = profile.history || [];
  const loans = profile.loans || [];
  const boost = profile.boost || { doubleMoneyUntil: 0 };
  const clickValue = profile.clickValue || 1;
  const clickLevel = profile.clickLevel || 1;
  const now = Date.now();
  const starterBoostActive = now < (profile.shop?.starterBoostUntil || 0);

  const permanentMultiplier = profile.shop?.permanentMultiplier || 1;
  const timeBoostMultiplier = now < (boost.doubleMoneyUntil || 0) ? 2 : 1;
  const starterMultiplier = now < (profile.shop?.starterBoostUntil || 0) ? 2 : 1;
  const leaderboardMultiplier =
    now < (profile.shop?.leaderboardClickMultiplierUntil || 0) ? 2 : 1;
  const limitedMultiplier =
    Date.now() < (profile.shop?.limitedMultiplierUntil || 0)
      ? (profile.shop?.limitedMultiplierValue || 1)
      : 1;
  const prestigeMultiplier = getPrestigeMultiplier(profile);

  const displayedClickValue =
    clickValue *
    permanentMultiplier *
    timeBoostMultiplier *
    starterMultiplier *
    leaderboardMultiplier *
    limitedMultiplier *
    prestigeMultiplier;

  const autoClickToggleBtn = document.getElementById("autoClickToggleBtn");
  const historyPrevBtn = document.getElementById("historyPrevBtn");
  const historyNextBtn = document.getElementById("historyNextBtn");
  const historyPageInfo = document.getElementById("historyPageInfo");

  const passiveIncomeInfo = document.getElementById("passiveIncomeInfo");
  const investmentsList = document.getElementById("investmentsList");
  const homePassiveIncomeText = document.getElementById("homePassiveIncomeText");

  const cardPinSetupHome = document.getElementById("cardPinSetupHome");

  const boostBtn = document.getElementById("boostBtn");
  const loanBtn1 = document.getElementById("loanBtn1");
  const loanBtn2 = document.getElementById("loanBtn2");
  const loanBtn3 = document.getElementById("loanBtn3");

  const playerLevelText = document.getElementById("playerLevelText");
  const playerXpText = document.getElementById("playerXpText");
  const playerXpBar = document.getElementById("playerXpBar");

  if (balanceEl) animateNumber(balanceEl, balance);
  if (welcomeEl) {
    welcomeEl.innerText = `Bienvenue ${profile.displayName || profile.username} • Compte actif : ${activeAccount}`;
  }

  if (clickLevelText) {
    let suffix = "";
    if (permanentMultiplier > 1) suffix += ` • x${permanentMultiplier} à vie`;
    if (timeBoostMultiplier > 1) suffix += ` • x2 actif`;
    if (starterMultiplier > 1) suffix += ` • pack débutant`;
    if (timeBoostMultiplier > 1) suffix += " • x2 boost";
    if (starterMultiplier > 1) suffix += " • starter x2";
    if (leaderboardMultiplier > 1) suffix += " • TOP 1 x2";
    if (prestigeMultiplier > 1) suffix += ` • Prestige x${prestigeMultiplier.toFixed(1)}`;

    clickLevelText.innerText = `Gain par clic : ${formatMoney(displayedClickValue)}${suffix}`;
  }

  const nextUpgrade = getNextUpgrade(clickLevel);
  if (clickUpgradeInfo) {
    clickUpgradeInfo.innerText = nextUpgrade
      ? `Niveau actuel : ${clickLevel} • Prochaine amélioration : ${formatMoney(nextUpgrade.cost)} € pour passer à ${formatMoney(nextUpgrade.value)} €/clic`
      : `Niveau maximal atteint`;
  }

  if (boostInfo) {
    const timeBoostActive = now < (boost.doubleMoneyUntil || 0);
    if (timeBoostActive) {
      const remaining = (boost.doubleMoneyUntil || 0) - now;
      const minutes = Math.floor(remaining / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000);
      boostInfo.innerText = `Boost actif pendant encore ${minutes} min ${seconds} s`;
    } else if (starterBoostActive) {
      boostInfo.innerText = "Boost du pack débutant actif";
    } else {
      boostInfo.innerText = "Aucun boost actif";
    }
  }

  if (loanInfo) {
    const totalDebt = loans.reduce((sum, loan) => sum + (loan.amountRemaining || 0), 0);
    loanInfo.innerText = `Dette totale : ${formatMoney(totalDebt)}`;
  }

  if (loanList) {
    loanList.innerHTML = loans.length
      ? loans.map((loan, index) => `
          <div class="list-item">Crédit #${index + 1} — restant : ${formatMoney(loan.amountRemaining || 0)}</div>
        `).join("")
      : '<div class="list-item">Aucun crédit en cours.</div>';
  }

  if (loanTimer) {
    if (!loans.length) {
      loanTimer.innerText = "Aucun prélèvement automatique en attente.";
    } else {
      const lastLoanAutoPayment = profile.lastLoanAutoPayment || 0;
      const nextTime = lastLoanAutoPayment + (2 * 60 * 1000);
      const remaining = Math.max(0, nextTime - now);
      const minutes = Math.floor(remaining / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000);
      loanTimer.innerText = `Prochain prélèvement auto de 100 € dans ${minutes} min ${seconds} s`;
    }
  }

  if (accountsList) {
    accountsList.innerHTML = Object.entries(accounts).map(([name, amount]) => `
      <div class="list-item">
        <strong>${name}</strong> — ${formatMoney(amount)}
        ${name === activeAccount ? '<span class="small"> (actif)</span>' : ''}
      </div>
    `).join("");
  }

  const paginatedHistory = paginateItems(history, historyPage, HISTORY_PER_PAGE);
  historyPage = paginatedHistory.currentPage;

  if (historyEl) {
    historyEl.innerHTML = paginatedHistory.items.length
      ? paginatedHistory.items.map(item => `<div class="list-item">${item}</div>`).join("")
      : '<div class="list-item">Aucune transaction pour le moment.</div>';
  }

  if (historyPageInfo) {
    historyPageInfo.innerText = `Page ${paginatedHistory.currentPage} / ${paginatedHistory.totalPages}`;
  }

  if (historyPrevBtn) {
    historyPrevBtn.disabled = paginatedHistory.currentPage <= 1;
  }

  if (historyNextBtn) {
    historyNextBtn.disabled = paginatedHistory.currentPage >= paginatedHistory.totalPages;
  }

  if (adminAddMoneyBtn) {
    adminAddMoneyBtn.style.display = profile.isAdmin ? "inline-block" : "none";
  }

  const card = profile.card || { blocked: false, revealed: false, type: "classic" };

  if (cardOwnerName) {
    cardOwnerName.innerText = (profile.username || profile.displayName || "UTILISATEUR").toUpperCase();
  }

  if (maskedCardNumber) {
    maskedCardNumber.innerText = card.revealed ? "1234 5678 9012 4821" : "**** **** **** 4821";
  }

  if (maskedExpiry) {
    maskedExpiry.innerText = card.revealed ? "12/28" : "••/••";
  }

  if (maskedCvv) {
    maskedCvv.innerText = card.revealed ? "123" : "***";
  }

  if (cardIban) {
    cardIban.innerText = profile.iban || "FR76 XXXX XXXX XXXX";
  }

  if (cardStatusText) {
    cardStatusText.innerText = card.blocked ? "Carte bloquée" : "Carte active";
    cardStatusText.className = "status-pill " + (card.blocked ? "negative" : "positive");
  }

  const cardType = card.type || "classic";

  if (cardFront) {
    cardFront.classList.remove("classic", "premium", "black");
    cardFront.classList.add(cardType);
  }
  if (cardBack) {
    cardBack.classList.remove("classic", "premium", "black");
    cardBack.classList.add(cardType);
  }
  if (cardTypeSelect) {
    const ownsGold = !!profile.shop?.ownsGoldCard || !!profile.shop?.visualPack || !!profile.isAdmin;
    const ownsBlack = !!profile.shop?.ownsBlackCard || !!profile.shop?.visualPack || !!profile.isAdmin;

    Array.from(cardTypeSelect.options).forEach(option => {
      if (option.value === "premium") {
        option.disabled = !ownsGold;
        option.text = ownsGold ? "Premium" : "Premium 🔒";
      }

      if (option.value === "black") {
        option.disabled = !ownsBlack;
        option.text = ownsBlack ? "Black" : "Black 🔒";
      }
    });

    if (
      (card.type === "premium" && !ownsGold) ||
      (card.type === "black" && !ownsBlack)
    ) {
      profile.card.type = "classic";
      await updateUserProfile(uid, { card: profile.card });
    }

    cardTypeSelect.value = profile.card?.type || "classic";
  }

  if (cardPinSetupHome) {
    cardPinSetupHome.style.display = card.pin ? "none" : "block";
  }

  if (autoClickToggleBtn) {
    const owned = !!profile.shop?.autoClicker;
    const enabled = !!profile.shop?.autoClickerEnabled;

    if (!owned) {
      autoClickToggleBtn.innerText = "Acheter Auto-Click";
      autoClickToggleBtn.className = "secondary";
    } else if (enabled) {
      autoClickToggleBtn.innerText = "Auto-Click ON";
      autoClickToggleBtn.className = "positive";
    } else {
      autoClickToggleBtn.innerText = "Auto-Click OFF";
      autoClickToggleBtn.className = "negative";
    }
  }
  profile.investments = profile.investments || {};

  let totalPassiveIncome = 0;

  INVESTMENTS.forEach(inv => {
    const qty = profile.investments[inv.id] || 0;
    totalPassiveIncome += qty * inv.incomePerSecond;
  });

  if (passiveIncomeInfo) {
    passiveIncomeInfo.innerText = `Revenus passifs : ${formatMoney(totalPassiveIncome)} / sec`;
  }

  if (homePassiveIncomeText) {
    homePassiveIncomeText.innerText = `Revenus passifs : ${formatMoney(getTotalPassiveIncome(profile))} / sec`;
  }

  const inflationMultiplier = getInflationMultiplier(profile);
  const wealthLevel = getPlayerWealthLevel(profile);
  const dynamicBoostPrice = getDynamicBoostPrice(profile);
  const dynamicLoans = getDynamicLoanAmounts(profile);

  if (boostBtn) {
    boostBtn.innerText = `x2 argent (1 min) — ${formatMoney(dynamicBoostPrice)}`;
  }

  const loanButtons = [loanBtn1, loanBtn2, loanBtn3];

  loanButtons.forEach((btn, index) => {
    if (!btn) return;
    const amount = dynamicLoans[index];
    btn.innerText = `Crédit ${formatMoney(amount)}`;
    btn.dataset.loanAmount = amount;
  });

  const inflationInfo = document.getElementById("inflationInfo");
  if (inflationInfo) {
    inflationInfo.innerText = `Niveau économique : ${wealthLevel} • Inflation x${inflationMultiplier}`;
  }

  const levelData = getLevelFromXp(profile.xp || 0);

  if (playerLevelText) {
    playerLevelText.innerText = `Niveau ${levelData.level}`;
  }

  if (playerXpText) {
    playerXpText.innerText = `${Math.floor(levelData.currentXp).toLocaleString("fr-FR")} / ${levelData.requiredXp.toLocaleString("fr-FR")} XP`;
  }

  if (playerXpBar) {
    playerXpBar.style.width = `${levelData.percent}%`;
  }

  if (investmentsList) {
    investmentsList.innerHTML = INVESTMENTS.map(inv => {
      const qty = profile.investments[inv.id] || 0;
      return `
        <div class="list-item">
          <strong>${inv.emoji} ${inv.name}</strong><br>
          <span class="small">Possédé : ${qty} • Gain : ${formatMoney(qty * inv.incomePerSecond)} / sec</span><br>
          <span class="small">Prix : ${formatMoney(inv.cost)}</span>
          <div class="row" style="margin-top:8px;">
            <button class="buy-investment-btn" data-investment-id="${inv.id}">Acheter</button>
          </div>
        </div>
      `;
    }).join("");
  }
}


  async function takeLoanFirebase(uid, amount) {
    const profile = await getUserProfile(uid);
    if (!profile) return;
    applyUserTheme(profile);

    const activeAccount = profile.activeAccount || "Principal";
    const repayment = amount * 1.2;

    if (!profile.accounts) profile.accounts = {};
    if (!profile.accounts[activeAccount]) profile.accounts[activeAccount] = 0;
    if (!profile.loans) profile.loans = [];
    if (!profile.history) profile.history = [];

    profile.accounts[activeAccount] += amount;
    profile.loans.push({
      id: Date.now(),
      principal: amount,
      amountRemaining: repayment
  });

  // Très important : on démarre le timer maintenant,
  // donc le premier prélèvement arrivera dans 2 minutes
  profile.lastLoanAutoPayment = Date.now();

  profile.history.unshift(
    `Crédit obtenu +${amount.toFixed(2)} € (remboursement ${repayment.toFixed(2)} €)`
  );

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    loans: profile.loans,
    history: profile.history,
    lastLoanAutoPayment: profile.lastLoanAutoPayment,
    badges: profile.badges,
  });

  await renderHome(uid);
}

async function repayAllLoansFirebase(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;
  applyUserTheme(profile);

  const activeAccount = profile.activeAccount || "Principal";
  if (!profile.accounts) profile.accounts = {};
  if (!profile.loans) profile.loans = [];
  if (!profile.history) profile.history = [];

  let balance = profile.accounts[activeAccount] || 0;
  if (profile.loans.length === 0) {
    showToast("Aucun crédit à rembourser.", "error");
    return;
  }

  const totalDebt = profile.loans.reduce((sum, loan) => sum + (loan.amountRemaining || 0), 0);
  const amountToPay = Math.min(balance, totalDebt);

  if (amountToPay <= 0) {
    showToast("Pas assez d'argent.", "error");
    return;
  }

  let remaining = amountToPay;

  while (remaining > 0 && profile.loans.length > 0) {
    const loan = profile.loans[0];
    const payment = Math.min(loan.amountRemaining, remaining);

    loan.amountRemaining -= payment;
    remaining -= payment;
    balance -= payment;

    if (loan.amountRemaining <= 0.001) {
      profile.loans.shift();
    }
  }

  profile.accounts[activeAccount] = balance;
  profile.history.unshift(`Remboursement total/partiel crédit -${amountToPay.toFixed(2)} €`);

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    loans: profile.loans,
    history: profile.history,
    badges: profile.badges,
  });

  await renderHome(uid);
}

async function autoLoanPaymentFirebase(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;
  applyUserTheme(profile);

  const activeAccount = profile.activeAccount || "Principal";
  const loans = profile.loans || [];
  if (!loans.length) return;

  const now = Date.now();
  const last = profile.lastLoanAutoPayment || 0;
  const intervalMs = 2 * 60 * 1000;

  if (now - last < intervalMs) return;

  if (!profile.accounts) profile.accounts = {};
  let balance = profile.accounts[activeAccount] || 0;
  if (balance <= 0) {
    await updateUserProfile(uid, { lastLoanAutoPayment: now });
    return;
  }

  let remainingPayment = Math.min(100, balance);
  let paidTotal = 0;

  while (remainingPayment > 0 && loans.length > 0) {
    const loan = loans[0];
    const payment = Math.min(loan.amountRemaining, remainingPayment);

    loan.amountRemaining -= payment;
    remainingPayment -= payment;
    paidTotal += payment;
    balance -= payment;

    if (loan.amountRemaining <= 0.001) {
      loans.shift();
    }
  }

  profile.accounts[activeAccount] = balance;
  profile.loans = loans;
  profile.lastLoanAutoPayment = now;
  if (!profile.history) profile.history = [];
  if (paidTotal > 0) {
    profile.history.unshift(`Prélèvement auto crédit -${paidTotal.toFixed(2)} €`);
  }

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    loans: profile.loans,
    history: profile.history,
    lastLoanAutoPayment: profile.lastLoanAutoPayment,
    badges: profile.badges,
  });

  await renderHome(uid);
}


/*=============== CRYPTO ==============*/

async function renderInvestmentsInsideCrypto(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;
  applyUserTheme(profile);

  const incomeEl = document.getElementById("investmentIncomeInfo");
  const grid = document.getElementById("investmentsShop");

  if (!incomeEl || !grid) return;

  const activeAccount = profile.activeAccount || "Principal";
  const balance = profile.accounts?.[activeAccount] || 0;
  const totalIncome = getTotalPassiveIncome(profile);

  incomeEl.innerText = `Revenus passifs : ${formatMoney(totalIncome)} / sec`;

  profile.investments = profile.investments || {};

  grid.innerHTML = INVESTMENTS.map(inv => {
    const qty = profile.investments[inv.id] || 0;
    const finalCost = Math.round(inv.cost * getInflationMultiplier(profile));
    const canBuy = balance >= finalCost;

    return `
      <div class="investment-card">
        ${qty > 0 ? `<div class="investment-owned">x${qty}</div>` : ""}

        <div>
          <div class="investment-emoji">${inv.emoji}</div>
          <h3>${escapeHtml(inv.name)}</h3>
          <p class="small">Génère automatiquement de l'argent.</p>

          <div class="investment-stats">
            <div class="investment-stat">Prix : <strong>${formatMoney(finalCost)}</strong></div>
            <div class="investment-stat">Gain : <strong>${formatMoney(inv.incomePerSecond)} / sec</strong></div>
            <div class="investment-stat">Revenu actuel : <strong>${formatMoney(qty * inv.incomePerSecond)} / sec</strong></div>
          </div>
        </div>

        <button class="buy-investment-page-btn" data-investment-id="${inv.id}" ${canBuy ? "" : "disabled"}>
          ${canBuy ? "Acheter" : "Pas assez d'argent"}
        </button>
      </div>
    `;
  }).join("");

  document.querySelectorAll(".buy-investment-page-btn").forEach(btn => {
    btn.onclick = async () => {
      await buyInvestment(uid, btn.dataset.investmentId);
      await renderCrypto(uid);
      await renderInvestmentsInsideCrypto(uid);
    };
  });
}


async function buyInvestment(uid, investmentId) {
  const profile = await getUserProfile(uid);
  if (!profile) return;
  applyUserTheme(profile);

  const investment = INVESTMENTS.find(inv => inv.id === investmentId);
  if (!investment) return;

  const activeAccount = profile.activeAccount || "Principal";

  profile.accounts = profile.accounts || { Principal: 0 };
  profile.investments = profile.investments || {};
  profile.history = profile.history || [];

  const balance = profile.accounts[activeAccount] || 0;
  const finalCost = Math.round(investment.cost * getInflationMultiplier(profile));

  if (balance < finalCost) {
    showToast("Pas assez d'argent pour acheter cet investissement.", "error");
    return;
  }

  profile.accounts[activeAccount] = balance - finalCost;
  profile.investments[investment.id] = (profile.investments[investment.id] || 0) + 1;

  profile.history.unshift(`Investissement acheté : ${investment.name} -${formatMoney(finalCost)}`);

  addDailyQuestProgress(profile, "investmentBuy", 1);
  addXp(profile, 50, "Investissement");
  handleBadges(profile);


  await updateUserProfile(uid, {
    accounts: profile.accounts,
    investments: profile.investments,
    history: profile.history,
    dailyQuests: profile.dailyQuests,
    xp: profile.xp,
    badges: profile.badges,
  });

  await renderHome(uid);
}

async function applyPassiveIncome(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;
  applyUserTheme(profile);

  const activeAccount = profile.activeAccount || "Principal";

  profile.accounts = profile.accounts || { Principal: 0 };
  profile.investments = profile.investments || {};
  profile.history = profile.history || [];

  const now = Date.now();
  const last = profile.lastPassiveIncome || now;

  const elapsedMs = Math.max(0, now - last);
  const cappedElapsedMs = Math.min(elapsedMs, MAX_OFFLINE_PASSIVE_MS);
  const deltaSeconds = cappedElapsedMs / 1000;

  let gain = 0;

  INVESTMENTS.forEach(inv => {
    const qty = profile.investments[inv.id] || 0;
    gain += qty * inv.incomePerSecond * deltaSeconds;
  });

  profile.lastPassiveIncome = now;

  if (elapsedMs > MAX_OFFLINE_PASSIVE_MS) {
    profile.history.unshift(
      `Revenus passifs limités à 2h : +${formatMoney(gain)}`
    );
  }

  if (gain <= 0) {
    await updateUserProfile(uid, {
      lastPassiveIncome: profile.lastPassiveIncome
    });
    return;
  }

  profile.accounts[activeAccount] += gain;

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    lastPassiveIncome: profile.lastPassiveIncome,
    history: profile.history,
    badges: profile.badges,
  });
}

async function initHome(user) {

  bindNewsPopup(user.uid);
  bindLogout();
  await renderHome(user.uid);
    document.querySelectorAll(".buy-investment-btn").forEach(btn => {
    btn.onclick = async () => {
      await buyInvestment(user.uid, btn.dataset.investmentId);
    };
  });
  function bindInvestmentButtons(uid) {
    document.querySelectorAll(".buy-investment-btn").forEach(btn => {
      btn.onclick = async () => {
        await buyInvestment(uid, btn.dataset.investmentId);
        bindInvestmentButtons(uid);
      };
    });
  }

  const clickBtn = byIdOrLegacy("clickBtn", 'button[onclick="clickMoney()"]');
  const bonusBtn = byIdOrLegacy("bonusBtn", 'button[onclick="claimDailyBonus()"]');
  const upgradeBtn = byIdOrLegacy("upgradeBtn", 'button[onclick="upgradeClickIncome()"]');
  const boostBtn = byIdOrLegacy("boostBtn", 'button[onclick="buyDoubleMoneyBoost()"]');
  const loanBtn1 = document.getElementById("loanBtn1");
  const loanBtn2 = document.getElementById("loanBtn2");
  const loanBtn3 = document.getElementById("loanBtn3");
  const repayAllBtn = byIdOrLegacy("repayAllBtn", 'button[onclick="repayAllLoans()"]');
  const adminAddMoneyBtn = document.getElementById("adminAddMoneyBtn");

  const showFullCardBtn = document.getElementById("showFullCardBtn");
  const flipCardBtn = document.getElementById("flipCardBtn");
  const toggleCardBlockBtn = document.getElementById("toggleCardBlockBtn");
  const cardTypeSelect = document.getElementById("cardTypeSelect");
  const saveCardPinBtnHome = document.getElementById("saveCardPinBtnHome");

  const autoClickToggleBtn = document.getElementById("autoClickToggleBtn");
  const historyPrevBtn = document.getElementById("historyPrevBtn");
  const historyNextBtn = document.getElementById("historyNextBtn");

  if (clickBtn) {
    clickBtn.onclick = async () => {
      const profile = await getUserProfile(user.uid);
      const activeAccount = profile.activeAccount || "Principal";
      const clickValue = profile.clickValue || 1;

      const permanentMultiplier = profile.shop?.permanentMultiplier || 1;
      const timeBoostMultiplier = Date.now() < (profile.boost?.doubleMoneyUntil || 0) ? 2 : 1;
      const starterMultiplier = Date.now() < (profile.shop?.starterBoostUntil || 0) ? 2 : 1;
      const limitedMultiplier =
        Date.now() < (profile.shop?.limitedMultiplierUntil || 0)
          ? (profile.shop?.limitedMultiplierValue || 1)
          : 1;

      const leaderboardMultiplier =
        Date.now() < (profile.shop?.leaderboardClickMultiplierUntil || 0) ? 2 : 1;
      const prestigeMultiplier = getPrestigeMultiplier(profile);

      const gain =
        clickValue *
        permanentMultiplier *
        timeBoostMultiplier *
        starterMultiplier *
        leaderboardMultiplier *
        limitedMultiplier *
        prestigeMultiplier;

      addXp(profile, 1, "Clic", false);
      showMoneyPop(gain);
      profile.totalClicks = (profile.totalClicks || 0) + 1;
      addDailyQuestProgress(profile, "clicks", 1);
      addDailyQuestProgress(profile, "earnMoney", gain);
      const newBadges = checkBadges(profile);
      handleBadges(profile);

      await updateUserProfile(user.uid, {
        accounts: profile.accounts,
        totalClicks: profile.totalClicks,
        xp: profile.xp,
        badges: profile.badges
      });

      profile.accounts[activeAccount] = (profile.accounts[activeAccount] || 0) + gain;
      await updateUserProfile(user.uid, {
        accounts: profile.accounts,
        totalClicks: profile.totalClicks,
        dailyQuests: profile.dailyQuests,
        xp: profile.xp,
        badges: profile.badges,
      });
      bindInvestmentButtons(user.uid);
      await renderHome(user.uid);
    };
  }

  if (bonusBtn) {
    bonusBtn.onclick = async () => {
      const profile = await getUserProfile(user.uid);
      const activeAccount = profile.activeAccount || "Principal";
      const now = Date.now();
      const oneDay = 24 * 60 * 60 * 1000;

      if ((now - (profile.lastDailyBonus || 0)) < oneDay) {
        showToast("Cadeau déjà récupéré.", "warning");
        return;
      }

      profile.accounts = profile.accounts || { Principal: 0 };
      profile.history = profile.history || [];
      profile.boost = profile.boost || { doubleMoneyUntil: 0 };
      profile.crypto = profile.crypto || { currentAsset: "BTC", assets: {} };

      const reward = getRandomDailyReward();

      if (reward.type === "money") {
        profile.accounts[activeAccount] = (profile.accounts[activeAccount] || 0) + reward.value;
      }

      if (reward.type === "boost") {
        profile.boost.doubleMoneyUntil = Date.now() + reward.durationMs;
      }

      if (reward.type === "crypto") {
        if (!profile.crypto.assets[reward.asset]) {
          profile.crypto.assets[reward.asset] = {
            price: 0,
            owned: 0,
            avgBuyPrice: 0,
            history: [],
            transactions: []
          };
        }

        profile.crypto.assets[reward.asset].owned =
          (profile.crypto.assets[reward.asset].owned || 0) + reward.quantity;
      }

      profile.lastDailyBonus = now;
      profile.history.unshift(`Cadeau du jour : ${reward.label}`);

      await updateUserProfile(user.uid, {
        accounts: profile.accounts,
        boost: profile.boost,
        crypto: profile.crypto,
        lastDailyBonus: profile.lastDailyBonus,
        history: profile.history,
        badges: profile.badges,
      });

      historyPage = 1;
      await renderHome(user.uid);
      bindInvestmentButtons(user.uid);

      showToast(`Tu as reçu : ${reward.label}`, "succes");
    };
  }

  if (upgradeBtn) {
    upgradeBtn.onclick = async () => {
      const profile = await getUserProfile(user.uid);
      const activeAccount = profile.activeAccount || "Principal";
      const currentBalance = profile.accounts?.[activeAccount] || 0;
      const currentLevel = profile.clickLevel || 1;
      const nextUpgrade = getNextUpgrade(currentLevel);

      if (!nextUpgrade) return showToast("Niveau maximal atteint.", "error");
      if (currentBalance < nextUpgrade.cost) {
        return showToast(`Pas assez d'argent. Il faut ${nextUpgrade.cost} €.`, "error");
      }

      profile.accounts[activeAccount] = currentBalance - nextUpgrade.cost;
      profile.clickValue = nextUpgrade.value;
      profile.clickLevel = nextUpgrade.nextLevel;

      const newHistory = profile.history || [];
      newHistory.unshift(`Amélioration du clic -${formatMoney(nextUpgrade.cost.toFixed(2))} € → ${formatMoney(nextUpgrade.value)} €/clic`);

      await updateUserProfile(user.uid, {
        accounts: profile.accounts,
        clickValue: profile.clickValue,
        clickLevel: profile.clickLevel,
        history: newHistory,
        badges: profile.badges,
      });

      bindInvestmentButtons(user.uid);
      await renderHome(user.uid);
    };
  }

  if (boostBtn) {
    boostBtn.onclick = async () => {
      const profile = await getUserProfile(user.uid);
      const activeAccount = profile.activeAccount || "Principal";
      const currentBalance = profile.accounts?.[activeAccount] || 0;
      const now = Date.now();
      const boostPrice = getDynamicBoostPrice(profile);
      const durationMs = 60 * 1000;
      const boost = profile.boost || { doubleMoneyUntil: 0 };

      if (now < (boost.doubleMoneyUntil || 0)) {
        return showToast("Le boost x2 est déjà actif.", "error");
      }
      if (currentBalance < boostPrice) {
        return showToast(`Pas assez d'argent. Il faut ${boostPrice} €.`, "error");
      }

      profile.accounts[activeAccount] = currentBalance - boostPrice;
      profile.boost = { doubleMoneyUntil: now + durationMs };

      const newHistory = profile.history || [];
      newHistory.unshift(`Boost x2 acheté -${formatMoney(boostPrice.toFixed(2))} € (1 min)`);

      await updateUserProfile(user.uid, {
        accounts: profile.accounts,
        boost: profile.boost,
        history: newHistory,
        badges: profile.badges,
      });

      bindInvestmentButtons(user.uid);
      await renderHome(user.uid);
    };
  }

  [loanBtn1, loanBtn2, loanBtn3].forEach(btn => {
    if (!btn) return;

    btn.onclick = async () => {
      const amount = Number(btn.dataset.loanAmount);
      if (!amount || amount <= 0) return alert("Montant de crédit invalide.");
      await takeLoanFirebase(user.uid, amount);
    };
  });
  if (repayAllBtn) repayAllBtn.onclick = async () => await repayAllLoansFirebase(user.uid);

  if (adminAddMoneyBtn) {
    adminAddMoneyBtn.onclick = async () => {
      const profile = await getUserProfile(user.uid);
      if (!profile.isAdmin) return;

      const activeAccount = profile.activeAccount || "Principal";
      const amount = Number(prompt("Montant à ajouter au compte actif ?"));
      if (!amount || amount <= 0) return showToast("Montant invalide.", "error");

      profile.accounts[activeAccount] = (profile.accounts[activeAccount] || 0) + amount;
      const newHistory = profile.history || [];
      newHistory.unshift(`Ajout admin +${formatMoney(amount.toFixed(2))} €`);

      await updateUserProfile(user.uid, {
        accounts: profile.accounts,
        history: newHistory,
        badges: profile.badges,
      });

      bindInvestmentButtons(user.uid);
      await renderHome(user.uid);
    };
  }

  if (showFullCardBtn) {
    showFullCardBtn.onclick = async () => {
      const profile = await getUserProfile(user.uid);
      const entered = prompt("Entre le PIN de la carte :");
      if (!entered) return;

      if ((profile.card?.pin || "") !== entered) {
        return showToast("PIN incorrect.", "warning");
      }

      profile.card = profile.card || {};
      profile.card.revealed = !profile.card.revealed;
      await updateUserProfile(user.uid, { card: profile.card });
      bindInvestmentButtons(user.uid);
      await renderHome(user.uid);
    };
  }

  if (saveCardPinBtnHome) {
    saveCardPinBtnHome.onclick = async () => {
      const profile = await getUserProfile(user.uid);
      const newPin = document.getElementById("newCardPinHome").value.trim();

      if (!/^\d{4}$/.test(newPin)) {
        return showToast("Le PIN doit contenir exactement 4 chiffres.", "error");
      }

      profile.card = profile.card || {};
      profile.card.pin = newPin;
      profile.card.revealed = false;
      profile.card.blocked = false;
      profile.card.type = profile.card.type || "classic";

      await updateUserProfile(user.uid, {
        card: profile.card,
        badges: profile.badges,
      });

      document.getElementById("newCardPinHome").value = "";

      await renderHome(user.uid);
    };
  }

  if (flipCardBtn) {
    flipCardBtn.onclick = () => {
      const cardInner = document.getElementById("cardInner");
      if (cardInner) cardInner.classList.toggle("flip");
    };
  }

  if (toggleCardBlockBtn) {
    toggleCardBlockBtn.onclick = async () => {
      const profile = await getUserProfile(user.uid);
      profile.card = profile.card || {};
      profile.card.blocked = !profile.card.blocked;
      await updateUserProfile(user.uid, { card: profile.card });
      bindInvestmentButtons(user.uid);
      await renderHome(user.uid);
    };
  }

  if (cardTypeSelect) {
    cardTypeSelect.onchange = async () => {
      const profile = await getUserProfile(user.uid);
      profile.card = profile.card || {};
      profile.card.type = cardTypeSelect.value;
      await updateUserProfile(user.uid, { card: profile.card });
      bindInvestmentButtons(user.uid);
      await renderHome(user.uid);
    };
  }

  if (historyPrevBtn) {
    historyPrevBtn.onclick = async () => {
      if (historyPage > 1) {
        historyPage--;
        bindInvestmentButtons(user.uid);
        await renderHome(user.uid);
      }
    };
  }

  if (historyNextBtn) {
    historyNextBtn.onclick = async () => {
      const profile = await getUserProfile(user.uid);
      const history = profile.history || [];
      const totalPages = Math.max(1, Math.ceil(history.length / HISTORY_PER_PAGE));

      if (historyPage < totalPages) {
        historyPage++;
        bindInvestmentButtons(user.uid);
        await renderHome(user.uid);
      }
    };
  }

  if (autoClickToggleBtn) {
    autoClickToggleBtn.onclick = async () => {
      const profile = await getUserProfile(user.uid);
      profile.shop = profile.shop || {};

      if (!profile.shop.autoClicker) {
        window.location.href = "boutique.html";
        return;
      }

      profile.shop.autoClickerEnabled = !profile.shop.autoClickerEnabled;

      await updateUserProfile(user.uid, {
        shop: profile.shop,
        badges: profile.badges,
      });

      bindInvestmentButtons(user.uid);
      await renderHome(user.uid);
    };
  }

  setInterval(async () => {
    const freshProfile = await getUserProfile(user.uid);
    if (freshProfile?.shop?.autoClicker && freshProfile?.shop?.autoClickerEnabled) {
      const activeAccount = freshProfile.activeAccount || "Principal";
      const clickValue = freshProfile.clickValue || 1;
      const permanentMultiplier = freshProfile.shop?.permanentMultiplier || 1;
      const timeBoostMultiplier = Date.now() < (freshProfile.boost?.doubleMoneyUntil || 0) ? 2 : 1;
      const starterMultiplier = Date.now() < (freshProfile.shop?.starterBoostUntil || 0) ? 2 : 1;
      const gain = clickValue * permanentMultiplier * timeBoostMultiplier * starterMultiplier;

      freshProfile.accounts[activeAccount] = (freshProfile.accounts[activeAccount] || 0) + gain;
      await updateUserProfile(user.uid, { accounts: freshProfile.accounts });
    }

    await checkUnreadNews(user.uid);
    await applyPassiveIncome(user.uid);
    await autoLoanPaymentFirebase(user.uid);
    await checkAndClaimMissions(user.uid);
    await renderHome(user.uid);
    bindInvestmentButtons(user.uid);
  }, 1000);
}

// carte dans home
  window.toggleCardDetails = async () => {
    const user = await getCurrentUser();
    const profile = await getUserProfile(user.uid);

    const pin = prompt("Entre ton PIN carte");
    if (pin !== profile.card?.pin) {
      showToast("PIN incorrect", "error");
      return;
    }

    profile.card.revealed = !profile.card.revealed;
    await updateUserProfile(user.uid, { card: profile.card });

    historyPage = 1;
    await renderHome(user.uid);
  };



// Page Historique

function paginateItems(items, page, perPage) {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * perPage;
  const end = start + perPage;

  return {
    items: items.slice(start, end),
    currentPage: safePage,
    totalPages
  };
}

/* ================= PAYMENTS ================= */



async function renderPayments(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;
  applyUserTheme(profile);

  updateAdminNavVisibility(profile);

  const paymentBalance = document.getElementById("paymentBalance");
  const myIban = document.getElementById("myIban");
  const contactsList = document.getElementById("contactsList");
  const adminPanel = document.getElementById("adminPanel");

  const activeAccount = profile.activeAccount || "Principal";
  const balance = profile.accounts?.[activeAccount] || 0;

  if (paymentBalance) paymentBalance.innerText = formatMoney(balance);
  if (myIban) myIban.innerText = profile.iban || "";
  if (adminPanel) adminPanel.style.display = profile.isAdmin ? "block" : "none";

  const contacts = profile.contacts || [];
  if (contactsList) {
    contactsList.innerHTML = contacts.length
      ? contacts.map((contact, index) => `
        <div class="list-item">
          <strong>${escapeHtml(contact.name)}</strong><br>
          <span class="small">${escapeHtml(contact.iban)}</span><br>
          <div class="row" style="margin-top:8px;">
            <button data-contact-name="${escapeHtml(contact.name)}" data-contact-iban="${escapeHtml(contact.iban)}" class="use-contact-btn">Utiliser</button>
            <button class="secondary delete-contact-btn" data-contact-index="${index}">Supprimer</button>
          </div>
        </div>
      `).join("")
      : '<div class="list-item">Aucun contact enregistré.</div>';
  }

  document.querySelectorAll(".use-contact-btn").forEach(btn => {
    btn.onclick = () => {
      const nameInput = document.getElementById("paymentName");
      const ibanInput = document.getElementById("iban");
      if (nameInput) nameInput.value = btn.dataset.contactName;
      if (ibanInput) ibanInput.value = btn.dataset.contactIban;
    };
  });

  document.querySelectorAll(".delete-contact-btn").forEach(btn => {
    btn.onclick = async () => {
      const index = Number(btn.dataset.contactIndex);
      const freshProfile = await getUserProfile(uid);
      const contacts = freshProfile.contacts || [];
      contacts.splice(index, 1);
      await updateUserProfile(uid, { contacts });
      await renderPayments(uid);
    };
  });
}

async function initPayments(user) {
  bindLogout();
  await renderPayments(user.uid);

  const transferBtn = byIdOrLegacy("transferBtn", 'button[onclick="transfer()"]');
  const addContactBtn = byIdOrLegacy("addContactBtn", 'button[onclick="addContact()"]');
  const refreshContactsBtn = byIdOrLegacy("refreshContactsBtn", 'button[onclick="renderAllUsersAsContacts()"]');
  const adminSendBtn = byIdOrLegacy("adminSendBtn", 'button[onclick="adminSendMoney()"]');

  if (addContactBtn) {
    addContactBtn.onclick = async () => {
      const profile = await getUserProfile(user.uid);
      const name = prompt("Nom du contact ?");
      if (!name || !name.trim()) return;

      const iban = prompt("IBAN du contact ?");
      if (!iban || !iban.trim()) return;

      const contacts = profile.contacts || [];
      contacts.push({ name: name.trim(), iban: iban.trim() });

      await updateUserProfile(user.uid, { contacts });
      await renderPayments(user.uid);
    };
  }

  if (refreshContactsBtn) {
    refreshContactsBtn.onclick = async () => {
      const profile = await getUserProfile(user.uid);
      const allUsers = await getAllUsers();

      const contacts = allUsers
        .filter(u => u.email !== profile.email)
        .map(u => ({
          name: u.displayName || u.username || u.email,
          iban: u.iban
        }));

      await updateUserProfile(user.uid, { contacts });
      await renderPayments(user.uid);
    };
  }

  if (transferBtn) {
    transferBtn.onclick = async () => {
      const sender = await getUserProfile(user.uid);
      const beneficiaryName = document.getElementById("paymentName")?.value.trim() || "";
      const beneficiaryIban = document.getElementById("iban")?.value.trim() || "";
      const amount = Number(document.getElementById("amount")?.value);

      if (!beneficiaryName && !beneficiaryIban) return showToast("Entre un bénéficiaire ou un IBAN.", "error");
      if (!amount || amount <= 0) return showToast("Entre un montant valide.", "error");

      const activeAccount = sender.activeAccount || "Principal";
      const senderBalance = sender.accounts?.[activeAccount] || 0;
      if (senderBalance < amount) return showToast("Pas assez d'argent.", "error");

      const allUsers = await getAllUsers();
      const target = allUsers.find(u =>
        (beneficiaryIban && u.iban === beneficiaryIban) ||
        (beneficiaryName && ((u.displayName || "").toLowerCase() === beneficiaryName.toLowerCase() || (u.username || "").toLowerCase() === beneficiaryName.toLowerCase()))
      );

      if (!target) return showToast("Aucun compte Rafael Bank trouvé.", "error");
      if (target.uid === user.uid) return showToast("Tu ne peux pas t'envoyer de virement à toi-même.", "error");

      const receiver = await getUserProfile(target.uid);
      const receiverActiveAccount = receiver.activeAccount || "Principal";

      sender.accounts[activeAccount] = senderBalance - amount;
      sender.history = sender.history || [];
      sender.history.unshift(`Virement envoyé à ${target.displayName || target.username} -${formatMoney(amount.toFixed(2))} €`);

      receiver.accounts = receiver.accounts || {};
      receiver.accounts[receiverActiveAccount] = (receiver.accounts[receiverActiveAccount] || 0) + amount;
      receiver.history = receiver.history || [];
      receiver.history.unshift(`Virement reçu de ${sender.displayName || sender.username} +${formatMoney(amount.toFixed(2))} €`);

      await updateUserProfile(user.uid, {
        accounts: sender.accounts,
        history: sender.history,
        badges: profile.badges,
      });

      await updateUserProfile(target.uid, {
        accounts: receiver.accounts,
        history: receiver.history,
        badges: profile.badges,
      });

      const amountInput = document.getElementById("amount");
      if (amountInput) amountInput.value = "";
      await renderPayments(user.uid);
    };
  }

  if (adminSendBtn) {
    adminSendBtn.onclick = async () => {
      const adminProfile = await getUserProfile(user.uid);
      if (!adminProfile.isAdmin) return;

      const targetValue = document.getElementById("adminTargetUser")?.value.trim() || "";
      const amount = Number(document.getElementById("adminAmount")?.value);

      if (!targetValue) return showToast("Entre un joueur.","error");
      if (!amount || amount <= 0) return showToast("Entre un montant valide.", "error");

      const allUsers = await getAllUsers();
      const target = allUsers.find(u =>
        (u.username || "").toLowerCase() === targetValue.toLowerCase() ||
        (u.displayName || "").toLowerCase() === targetValue.toLowerCase() ||
        (u.iban || "").toLowerCase() === targetValue.toLowerCase()
      );

      if (!target) return showToast("Joueur introuvable.", "error");
      if (target.uid === user.uid) return showToast("Impossible d'envoyer à toi-même ici.", "error");

      const targetProfile = await getUserProfile(target.uid);
      const targetActiveAccount = targetProfile.activeAccount || "Principal";

      targetProfile.accounts = targetProfile.accounts || {};
      targetProfile.accounts[targetActiveAccount] = (targetProfile.accounts[targetActiveAccount] || 0) + amount;
      targetProfile.history = targetProfile.history || [];
      targetProfile.history.unshift(`Cadeau admin +${formatMoney(amount.toFixed(2))} €`);

      adminProfile.history = adminProfile.history || [];
      adminProfile.history.unshift(`Envoi admin vers ${target.displayName || target.username} -${formatMoney(amount.toFixed(2))} €`);

      await updateUserProfile(target.uid, {
        accounts: targetProfile.accounts,
        history: targetProfile.history,
        badges: profile.badges,
      });

      await updateUserProfile(user.uid, {
        history: adminProfile.history,
        badges: profile.badges,
      });

      const adminTargetUserInput = document.getElementById("adminTargetUser");
      const adminAmountInput = document.getElementById("adminAmount");
      if (adminTargetUserInput) adminTargetUserInput.value = "";
      if (adminAmountInput) adminAmountInput.value = "";

      await renderPayments(user.uid);
      showToast("Argent envoyé.", "success");
    };
  }

  setInterval(async () => {
    await checkUnreadNews(user.uid);
    await renderPayments(user.uid);
  }, 1000);
}

/* ================= CARDS ================= */

async function renderCards(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;
  applyUserTheme(profile);

  ensureAdminOwnsEverything(profile);
document.body.classList.toggle("visual-premium", !!profile.shop?.visualPack || !!profile.isAdmin);

  updateAdminNavVisibility(profile);

  const cardPinSetup = document.getElementById("cardPinSetup");
  const cardOwnerName = document.getElementById("cardOwnerName");
  const maskedCardNumber = document.getElementById("maskedCardNumber");
  const maskedExpiry = document.getElementById("maskedExpiry");
  const maskedCvv = document.getElementById("maskedCvv");
  const cardIban = document.getElementById("cardIban");
  const cardStatusText = document.getElementById("cardStatusText");
  const cardFront = document.getElementById("cardFront");
  const cardBack = document.getElementById("cardBack");
  const cardTypeSelect = document.getElementById("cardTypeSelect");

  const card = profile.card || {
    blocked: false,
    revealed: false,
    type: "classic"
  };

  if (cardPinSetup) {
    cardPinSetup.style.display = card.pin ? "none" : "block";
  }

  if (cardOwnerName) {
    cardOwnerName.innerText = (profile.username || profile.displayName || "UTILISATEUR").toUpperCase();
  }

  if (maskedCardNumber) {
    maskedCardNumber.innerText = card.revealed ? "1234 5678 9012 4821" : "**** **** **** 4821";
  }

  if (maskedExpiry) {
    maskedExpiry.innerText = card.revealed ? "12/28" : "••/••";
  }

  if (maskedCvv) {
    maskedCvv.innerText = card.revealed ? "123" : "***";
  }

  if (cardIban) {
    cardIban.innerText = profile.iban || "FR76 XXXX XXXX XXXX";
  }

  if (cardStatusText) {
    cardStatusText.innerText = card.blocked ? "Carte bloquée" : "Carte active";
    cardStatusText.className = "status-pill " + (card.blocked ? "negative" : "positive");
  }

  const cardType = card.type || "classic";

  if (cardFront) {
    cardFront.classList.remove("classic", "premium", "black");
    cardFront.classList.add(cardType);
  }

  if (cardBack) {
    cardBack.classList.remove("classic", "premium", "black");
    cardBack.classList.add(cardType);
  }

  if (cardTypeSelect) {
    cardTypeSelect.value = cardType;
  }
}

async function initCards(user) {
  bindLogout();
  await renderCards(user.uid);

  const saveCardPinBtn = document.getElementById("saveCardPinBtn");
  const showFullCardBtn = document.getElementById("showFullCardBtn");
  const flipCardBtn = document.getElementById("flipCardBtn");
  const toggleCardBlockBtn = document.getElementById("toggleCardBlockBtn");
  const cardTypeSelect = document.getElementById("cardTypeSelect");

  if (saveCardPinBtn) {
    saveCardPinBtn.onclick = async () => {
      const profile = await getUserProfile(user.uid);
      const newCardPin = document.getElementById("newCardPin")?.value.trim() || "";

      if (!/^\d{4}$/.test(newCardPin)) {
        return showToast("Le PIN doit contenir exactement 4 chiffres.", "error");
      }

      profile.card = profile.card || {};
      profile.card.pin = newCardPin;
      profile.card.revealed = false;
      profile.card.blocked = profile.card.blocked || false;
      profile.card.type = profile.card.type || "classic";

      await updateUserProfile(user.uid, { card: profile.card, badges: profile.badges, });
      const newCardPinInput = document.getElementById("newCardPin");
      if (newCardPinInput) newCardPinInput.value = "";
      await renderCards(user.uid);
    };
  }

  if (showFullCardBtn) {
    showFullCardBtn.onclick = async () => {
      const profile = await getUserProfile(user.uid);
      const entered = prompt("Entre le PIN de la carte :");
      if (!entered) return;

      if ((profile.card?.pin || "") !== entered) {
        return showToast("PIN incorrect.", "error");
      }

      profile.card.revealed = !profile.card.revealed;
      await updateUserProfile(user.uid, { card: profile.card });
      await renderCards(user.uid);
    };
  }

  if (flipCardBtn) {
    flipCardBtn.onclick = () => {
      const cardInner = document.getElementById("cardInner");
      if (cardInner) cardInner.classList.toggle("flip");
    };
  }

  if (toggleCardBlockBtn) {
    toggleCardBlockBtn.onclick = async () => {
      const profile = await getUserProfile(user.uid);
      profile.card = profile.card || {};
      profile.card.blocked = !profile.card.blocked;
      await updateUserProfile(user.uid, { card: profile.card });
      await renderCards(user.uid);
    };
  }

  if (cardTypeSelect) {
    cardTypeSelect.onchange = async () => {
      const profile = await getUserProfile(user.uid);
      profile.card = profile.card || {};
      profile.card.type = cardTypeSelect.value;
      await updateUserProfile(user.uid, { card: profile.card });
      await renderCards(user.uid);
    };
  }
}

/* ================= GLOBAL MARKET ================= */

function defaultMarketAssets() {
  return {
    BTC: { price: formatMoney(30000), history: [30000, 30120, 30050] },
    ETH: { price: formatMoney(2000), history: [2000, 2015, 1998] },
    AAPL: { price: formatMoney(180), history: [180, 181, 179] },
    TSLA: { price: formatMoney(250), history: [250, 248, 252] },
    NVDA: { price: formatMoney(500), history: [500, 506, 503] },
    RCOP: { price: formatMoney(5000), history: [5000, 5035, 4990] }
  };
}

async function ensureGlobalMarket() {
  const market = await getGlobalMarket();
  if (market) return market;

  const defaultMarket = {
    randomMode: true,
    assets: defaultMarketAssets(),
    updatedAt: Date.now()
  };

  await setGlobalMarket(defaultMarket);
  return defaultMarket;
}

async function syncPlayerPortfolioWithMarket(uid) {
  const profile = await getUserProfile(uid);
  const market = await ensureGlobalMarket();
  if (!profile || !market) return null;

  if (!profile.crypto) {
    profile.crypto = {
      currentAsset: "BTC",
      assets: {}
    };
  }

  if (!profile.crypto.assets) {
    profile.crypto.assets = {};
  }

  Object.keys(market.assets).forEach(assetKey => {
    const marketAsset = market.assets[assetKey];

    if (!profile.crypto.assets[assetKey]) {
      profile.crypto.assets[assetKey] = {
        price: marketAsset.price,
        owned: 0,
        avgBuyPrice: 0,
        history: [...marketAsset.history],
        transactions: []
      };
    } else {
      profile.crypto.assets[assetKey].price = marketAsset.price;
      profile.crypto.assets[assetKey].history = [...marketAsset.history];

      if (typeof profile.crypto.assets[assetKey].owned !== "number") {
        profile.crypto.assets[assetKey].owned = 0;
      }

      if (typeof profile.crypto.assets[assetKey].avgBuyPrice !== "number") {
        profile.crypto.assets[assetKey].avgBuyPrice = 0;
      }

      if (!Array.isArray(profile.crypto.assets[assetKey].transactions)) {
        profile.crypto.assets[assetKey].transactions = [];
      }
    }
  });

  if (!profile.crypto.currentAsset) {
    profile.crypto.currentAsset = "BTC";
  }

  await updateUserProfile(uid, { crypto: profile.crypto, badges: profile.badges, });
  return { profile, market };
}

/* ================= CRYPTO ================= */

function renderCryptoChart(profile) {
  const canvas = document.getElementById("cryptoChart");
  if (!canvas || typeof window.Chart === "undefined") return;

  const assetKey = profile.crypto?.currentAsset || "BTC";
  const asset = profile.crypto?.assets?.[assetKey];
  if (!asset) return;

  let data = Array.isArray(asset.history) ? [...asset.history] : [];
  if (data.length < 2) data = [asset.price, asset.price];

  const isUp = data[data.length - 1] >= data[0];
  const borderColor = isUp ? "#22c55e" : "#ef4444";
  const backgroundColor = isUp ? "rgba(34,197,94,0.12)" : "rgba(239,68,68,0.12)";

  if (cryptoChart) {
    cryptoChart.destroy();
  }

  cryptoChart = new window.Chart(canvas, {
    type: "line",
    data: {
      labels: data.map((_, i) => i + 1),
      datasets: [{
        data,
        borderColor,
        backgroundColor,
        fill: true,
        borderWidth: 3,
        pointRadius: 2,
        tension: 0.35
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: false }
      },
      animation: { duration: 400 },
      scales: {
        x: {
          ticks: { color: "#94a3b8" },
          grid: { color: "rgba(148,163,184,0.08)" }
        },
        y: {
          ticks: { color: "#94a3b8" },
          grid: { color: "rgba(148,163,184,0.08)" }
        }
      }
    }
  });
}

async function renderCrypto(uid) {
  const synced = await syncPlayerPortfolioWithMarket(uid);
  if (!synced) return;

  const { profile, market } = synced;

  updateAdminNavVisibility(profile);

  const assetKey = profile.crypto?.currentAsset || "BTC";
  const asset = profile.crypto?.assets?.[assetKey];
  if (!asset) return;

  const portfolioEl = document.getElementById("portfolio");
  const cashBalanceEl = document.getElementById("cashBalance");
  const priceEl = document.getElementById("price");
  const holdingEl = document.getElementById("holding");
  const pnlEl = document.getElementById("pnl");
  const cryptoHistoryEl = document.getElementById("cryptoHistory");
  const assetSelect = document.getElementById("assetSelect");

  const adminCryptoPanel = document.getElementById("adminCryptoPanel");
  const toggleCryptoModeBtn = document.getElementById("toggleCryptoModeBtn");
  const cryptoModeInfo = document.getElementById("cryptoModeInfo");
  const adminAssetSelect = document.getElementById("adminAssetSelect");
  const adminAssetPrice = document.getElementById("adminAssetPrice");

  const activeAccount = profile.activeAccount || "Principal";
  const balance = profile.accounts?.[activeAccount] || 0;

  let totalPortfolio = 0;
  Object.values(profile.crypto.assets || {}).forEach(a => {
    totalPortfolio += (a.owned || 0) * (a.price || 0);
  });

  if (portfolioEl) portfolioEl.innerText = `Valeur totale du portefeuille : ${formatMoney(totalPortfolio)}`;
  if (cashBalanceEl) cashBalanceEl.innerText = `Solde disponible : ${formatMoney(balance)}`;
  if (priceEl) priceEl.innerText = `${assetKey} : ${formatMoney(asset.price || 0)}`;

  if (holdingEl) {
    holdingEl.innerText = `Possédé : ${(asset.owned || 0).toFixed(6)} unité(s) • Valeur : ${formatMoney((asset.owned || 0) * (asset.price || 0))}`;
  }

  const pnl = (asset.owned || 0) > 0
    ? ((asset.price || 0) - (asset.avgBuyPrice || 0)) * (asset.owned || 0)
    : 0;

  if (pnlEl) {
    pnlEl.innerHTML = `P/L latent : <span class="${pnl >= 0 ? "positive" : "negative"}">${pnl >= 0 ? "+" : ""}${formatMoney(pnl)}</span>`;
  }

  if (cryptoHistoryEl) {
    const txs = asset.transactions || [];
    cryptoHistoryEl.innerHTML = txs.length
      ? txs.map(item => `<div class="list-item">${item}</div>`).join("")
      : '<div class="list-item">Aucune transaction pour le moment.</div>';
  }

  if (assetSelect) assetSelect.value = assetKey;

  if (adminCryptoPanel) {
    adminCryptoPanel.style.display = profile.isAdmin ? "block" : "none";
  }

  if (toggleCryptoModeBtn) {
    toggleCryptoModeBtn.innerText = market.randomMode
      ? "Passer en mode manuel"
      : "Repasser en mode aléatoire";
  }

  if (cryptoModeInfo) {
    cryptoModeInfo.innerText = market.randomMode
      ? "Mode actuel : aléatoire"
      : "Mode actuel : manuel";
  }

  const marketNewsTitle = document.getElementById("marketNewsTitle");
  const marketNewsDescription = document.getElementById("marketNewsDescription");

  const currentNews = await getGlobalNews();

  if (marketNewsTitle) {
    marketNewsTitle.innerText = currentNews?.title || "Aucune news active";
  }

  if (marketNewsDescription) {
    marketNewsDescription.innerText = currentNews?.description || "Le marché est calme pour le moment.";
  }

  if (adminAssetSelect) adminAssetSelect.value = assetKey;
  if (adminAssetPrice) adminAssetPrice.value = Number(asset.price || 0).toFixed(2);

  renderCryptoChart(profile);
}

async function buyCrypto(uid) {
  const synced = await syncPlayerPortfolioWithMarket(uid);
  if (!synced) return;

  const { profile } = synced;

  const input = document.getElementById("investAmount");
  if (!input) return;

  const amount = Number(input.value);
  if (!amount || amount <= 0) return showToast("Entre un montant valide.", "error");

  const activeAccount = profile.activeAccount || "Principal";
  const balance = profile.accounts?.[activeAccount] || 0;
  if (balance < amount) return showToast("Pas assez d'argent.","error");

  const assetKey = profile.crypto.currentAsset;
  const asset = profile.crypto.assets[assetKey];
  if (!asset) return;

  const qty = amount / asset.price;
  const oldQty = asset.owned || 0;
  const oldCost = oldQty * (asset.avgBuyPrice || 0);

  asset.owned = oldQty + qty;
  asset.avgBuyPrice = (oldCost + amount) / asset.owned;

  profile.accounts[activeAccount] = balance - amount;
  profile.history = profile.history || [];
  asset.transactions = asset.transactions || [];

  const line = `Achat ${assetKey} • ${formatMoney(amount)} • ${qty.toFixed(6)} unité(s) à ${formatMoney(asset.price)}`;
  asset.transactions.unshift(line);
  profile.history.unshift(line);

  addXp(profile, 25, "Achat crypto");
  addDailyQuestProgress(profile, "cryptoBuy", 1);
  handleBadges(profile);

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    history: profile.history,
    crypto: profile.crypto,
    dailyQuests: profile.dailyQuests,
    xp: profile.xp,
    badges: profile.badges,
  });

  input.value = "";
  await renderCrypto(uid);
}

async function sellPartialCrypto(uid) {
  const synced = await syncPlayerPortfolioWithMarket(uid);
  if (!synced) return;

  const { profile } = synced;

  const input = document.getElementById("sellAmount");
  if (!input) return;

  const qty = Number(input.value);
  if (!qty || qty <= 0) return showToast("Quantité invalide.", "error");

  const activeAccount = profile.activeAccount || "Principal";
  const assetKey = profile.crypto.currentAsset;
  const asset = profile.crypto.assets[assetKey];
  if (!asset) return;
  if (qty > (asset.owned || 0)) return showToast("Pas assez d’unités.", "error");

  const saleValue = qty * asset.price;
  const costBasis = qty * (asset.avgBuyPrice || 0);
  const pnl = saleValue - costBasis;

  asset.owned -= qty;
  if (asset.owned <= 0.0000001) {
    asset.owned = 0;
    asset.avgBuyPrice = 0;
  }

  profile.accounts[activeAccount] = (profile.accounts[activeAccount] || 0) + saleValue;
  profile.history = profile.history || [];
  asset.transactions = asset.transactions || [];

  const line = `Vente partielle ${assetKey} • ${formatMoney(saleValue)} • ${qty.toFixed(6)} unité(s) • ${pnl >= 0 ? "Gain" : "Perte"} ${formatMoney(pnl)}`;
  asset.transactions.unshift(line);
  profile.history.unshift(line);

  addXp(profile, 15, "Vente crypto");
  handleBadges(profile);

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    history: profile.history,
    crypto: profile.crypto,
    xp: profile.xp,
    badges: profile.badges,
  });

  input.value = "";
  await renderCrypto(uid);
}

async function sellAllCrypto(uid) {
  const synced = await syncPlayerPortfolioWithMarket(uid);
  if (!synced) return;

  const { profile } = synced;

  const activeAccount = profile.activeAccount || "Principal";
  const assetKey = profile.crypto.currentAsset;
  const asset = profile.crypto.assets[assetKey];
  if (!asset || (asset.owned || 0) <= 0) return showToast("Rien à vendre.", "error");

  const qty = asset.owned;
  const saleValue = qty * asset.price;
  const costBasis = qty * (asset.avgBuyPrice || 0);
  const pnl = saleValue - costBasis;

  profile.accounts[activeAccount] = (profile.accounts[activeAccount] || 0) + saleValue;
  profile.history = profile.history || [];
  asset.transactions = asset.transactions || [];

  const line = `Vente ${assetKey} • ${formatMoney(saleValue)} • ${qty.toFixed(6)} unité(s) • ${pnl >= 0 ? "Gain" : "Perte"} ${formatMoney(pnl)}`;
  asset.transactions.unshift(line);
  profile.history.unshift(line);

  asset.owned = 0;
  asset.avgBuyPrice = 0;

  addXp(profile, 15, "Vente crypto");
  handleBadges(profile);

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    history: profile.history,
    crypto: profile.crypto,
    xp: profile.xp,
    badges: profile.badges,
  });

  await renderCrypto(uid);
}

async function tickGlobalCryptoMarket(uid) {
  const market = await ensureGlobalMarket();
  if (!market) return;

  if (market.randomMode) {
    Object.keys(market.assets).forEach(key => {
      const asset = market.assets[key];

      if (typeof asset.price !== "number" || asset.price <= 0) {
        asset.price = 100;
      }

      if (!Array.isArray(asset.history)) {
        asset.history = [asset.price];
      }

      const changePercent = (Math.random() * 2 - 1) * 0.02;
      const newPrice = Math.max(0.01, asset.price * (1 + changePercent));

      asset.price = newPrice;
      asset.history.push(newPrice);
      if (asset.history.length > 30) {
        asset.history.shift();
      }
    });

    await setGlobalMarket({
      ...market,
      updatedAt: Date.now()
    });
  }

  await renderCrypto(uid);
}

async function initCrypto(user) {
  bindNewsPopup(user.uid);
  bindLogout();
  await renderCrypto(user.uid);
  await renderInvestmentsInsideCrypto(user.uid);

  const assetSelect = document.getElementById("assetSelect");
  const buyBtn = document.getElementById("buyBtn");
  const sellPartialBtn = document.getElementById("sellPartialBtn");
  const sellAllBtn = document.getElementById("sellAllBtn");

  const toggleCryptoModeBtn = document.getElementById("toggleCryptoModeBtn");
  const adminAssetSelect = document.getElementById("adminAssetSelect");
  const adminSetCryptoPriceBtn = document.getElementById("adminSetCryptoPriceBtn");

  if (assetSelect) {
    assetSelect.onchange = async () => {
      const profile = await getUserProfile(user.uid);
      profile.crypto = profile.crypto || {};
      profile.crypto.currentAsset = assetSelect.value;
      await updateUserProfile(user.uid, { crypto: profile.crypto, badges: profile.badges, });
      await renderCrypto(user.uid);
    };
  }

  if (buyBtn) buyBtn.onclick = async () => await buyCrypto(user.uid);
  if (sellPartialBtn) sellPartialBtn.onclick = async () => await sellPartialCrypto(user.uid);
  if (sellAllBtn) sellAllBtn.onclick = async () => await sellAllCrypto(user.uid);

  if (toggleCryptoModeBtn) {
    toggleCryptoModeBtn.onclick = async () => {
      const profile = await getUserProfile(user.uid);
      if (!profile.isAdmin) return;

      market.randomMode = !market.randomMode;
      const market = await ensureGlobalMarket();
      market.randomMode = !market.randomMode;
      await setGlobalMarket(market);
      await renderCrypto(user.uid);
    };
  }

  if (adminAssetSelect) {
    adminAssetSelect.onchange = async () => {
      const profile = await getUserProfile(user.uid);
      if (!profile.isAdmin) return;

      profile.crypto = profile.crypto || {};
      profile.crypto.currentAsset = adminAssetSelect.value;
      await updateUserProfile(user.uid, { crypto: profile.crypto, badges: profile.badges, });
      await renderCrypto(user.uid);
    };
  }

  if (adminSetCryptoPriceBtn) {
    adminSetCryptoPriceBtn.onclick = async () => {
      const profile = await getUserProfile(user.uid);
      if (!profile.isAdmin) return;

      const input = document.getElementById("adminAssetPrice");
      if (!input) return;

      const newPrice = Number(input.value.replace(",", "."));
      if (!newPrice || newPrice <= 0) return showToast("Prix invalide.", "error");

      const market = await ensureGlobalMarket();
      const assetKey = profile.crypto?.currentAsset || "BTC";
      const asset = market.assets[assetKey];
      if (!asset) return;

      asset.price = newPrice;
      asset.history = asset.history || [];
      asset.history.push(newPrice);
      if (asset.history.length > 30) asset.history.shift();

      await setGlobalMarket({
        ...market,
        updatedAt: Date.now()
      });

      profile.history = profile.history || [];
      profile.history.unshift(`Prix admin défini pour ${assetKey} : ${newPrice.toFixed(2)} €`);
      await updateUserProfile(user.uid, { history: profile.history, badges: profile.badges, });

      await renderCrypto(user.uid);
    };
  }

  setInterval(async () => {
    await applyPassiveIncome(user.uid);
    await tickGlobalCryptoMarket(user.uid);
    const news = await getGlobalNews();
    if (!news || Date.now() > (news.expiresAt || 0)) {
      await triggerRandomNews();
    }
    await checkUnreadNews(user.uid);

    await renderInvestmentsInsideCrypto(user.uid);
  }, 1000);
}

/* ================= ADMIN ================= */

function getTotalUserBalance(userData) {
  return Object.values(userData.accounts || {}).reduce((sum, value) => sum + Number(value || 0), 0);
}

function toggleHistoryPopup(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = el.style.display === "none" ? "block" : "none";
}

window.toggleHistoryPopup = toggleHistoryPopup;

async function renderAdmin(user) {
  currentAdminUid = user.uid;
  const profile = await getUserProfile(user.uid);
  if (!profile || !profile.isAdmin) {
    window.location.href = "home.html";
    return;
  }

  updateAdminNavVisibility(profile);

  const container = document.getElementById("adminUsersList");
  if (!container) return;

  const allUsers = await getAllUsers();

  container.innerHTML = allUsers.map((u, index) => {
    const totalBalance = getTotalUserBalance(u);
    const historyId = `historyPopup${index}`;
    const cryptoHistoryId = `cryptoHistoryPopup${index}`;
    const stripeHistoryId = `stripeHistoryPopup${index}`;

    const cryptoHistoryLines = Object.entries(u.crypto?.assets || {}).flatMap(([assetKey, asset]) => {
      const txs = Array.isArray(asset.transactions) ? asset.transactions : [];
      return txs.map(line => `${assetKey} — ${line}`);
    });

    return `
      <div class="card" style="margin-bottom:16px;">
        <h3>${escapeHtml(u.displayName || u.username || "Utilisateur")}</h3>
        <p><strong>Nom d'utilisateur :</strong> ${escapeHtml(u.username || "")}</p>
        <p><strong>Email :</strong> ${escapeHtml(u.email || "")}</p>
        <p><strong>PIN carte :</strong> ${escapeHtml(u.card?.pin || "Aucun")}</p>
        <p><strong>IBAN :</strong> ${escapeHtml(u.iban || "")}</p>
        <p><strong>Solde total :</strong> ${formatMoney(totalBalance)}</p>
        <p><strong>Compte admin :</strong> ${u.isAdmin ? "Oui" : "Non"}</p>

        <div class="row">
          <button onclick="toggleHistoryPopup('${historyId}')">Historique banque</button>
          <button onclick="toggleHistoryPopup('${cryptoHistoryId}')">Historique crypto</button>
          <button onclick="toggleHistoryPopup('${stripeHistoryId}')">Historique Stripe</button>
          <button onclick="adminRemoveMoney('${u.uid}')">Retirer argent</button>
        </div>

        <div id="${historyId}" class="history-popup" style="display:none; margin-top:12px;">
          ${renderAdminHistory(u.uid, u.history || [])}
        </div>

        <div id="${cryptoHistoryId}" class="history-popup" style="display:none; margin-top:12px;">
          <div class="list-item">
            ${
              cryptoHistoryLines.length
                ? cryptoHistoryLines.map(item => `<div style="margin-bottom:6px;">${escapeHtml(item)}</div>`).join("")
                : "Aucun historique crypto."
            }
          </div>
        </div>

        <div id="${stripeHistoryId}" class="history-popup" style="display:none; margin-top:12px;">
          <div class="list-item" id="stripe-history-${u.uid}">
            Chargement historique Stripe...
          </div>
        </div>

      </div>
    `;
  }).join("");

  for (const u of allUsers) {
    const el = document.getElementById(`stripe-history-${u.uid}`);
    if (!el) continue;

    try {
      const stripeHistory = await getStripeHistory(u.uid);

      el.innerHTML = stripeHistory.length
        ? stripeHistory.map(item => `
            <div style="margin-bottom:12px;">
              <strong>${escapeHtml(getStripeProductName(item))}</strong><br>
              Statut : ${escapeHtml(getStripeStatus(item))}<br>
              Mode : ${escapeHtml(item.mode || "N/A")}<br>
              Prix Stripe : ${escapeHtml(item.price || "N/A")}<br>
              Date : ${escapeHtml(formatDateTime(item.createdAt || item.created || item.created_at))}<br>
              Session : ${escapeHtml(item.id)}
            </div>
          `).join("")
        : "Aucun historique Stripe.";
    } catch (e) {
      el.innerHTML = "Impossible de charger l'historique Stripe.";
      console.error(e);
    }
  }
}

async function getStripeHistory(uid) {
  const sessionsSnap = await getDocs(collection(db, "customers", uid, "checkout_sessions"));

  return sessionsSnap.docs.map(d => ({
    id: d.id,
    type: "Checkout",
    ...d.data()
  }));
}

window.adminRemoveMoney = async function(uid) {
  const target = await getUserProfile(uid);
  if (!target) return showToast("Utilisateur introuvable.", "error");

  const activeAccount = target.activeAccount || "Principal";
  target.accounts = target.accounts || { Principal: 0 };

  const currentBalance = target.accounts[activeAccount] || 0;
  const amount = Number(prompt(`Montant à retirer ? Solde actuel : ${currentBalance.toFixed(2)} €`));

  if (!amount || amount <= 0) {
    showToast("Montant invalide.", "error");
    return;
  }

  if (currentBalance < amount) {
    showToast("Impossible : le joueur n'a pas assez d'argent.", "error");
    return;
  }

  target.accounts[activeAccount] = currentBalance - amount;
  target.history = target.history || [];
  target.history.unshift(`Retrait admin -${formatMoney(amount.toFixed(2))} €`);

  await updateUserProfile(uid, {
    accounts: target.accounts,
    history: target.history,
    badges: profile.badges,
  });

  showToast("Argent retiré.", "success");
  location.reload();
};


async function initAdmin(user) {
  bindNewsPopup(user.uid);
  bindLogout();
  await renderAdmin(user);
}

async function getUserStripeHistory(uid) {
  const paymentsSnap = await getDocs(collection(db, "customers", uid, "payments"));
  const subscriptionsSnap = await getDocs(collection(db, "customers", uid, "subscriptions"));

  const payments = paymentsSnap.docs.map(d => ({
    type: "Paiement",
    id: d.id,
    ...d.data()
  }));

  const subscriptions = subscriptionsSnap.docs.map(d => ({
    type: "Abonnement",
    id: d.id,
    ...d.data()
  }));

  return [...payments, ...subscriptions];
}

const adminHistoryPages = {};
const ADMIN_HISTORY_PER_PAGE = 10;

function getAllShopItems() {
  return [
    ...(SHOP_ITEMS.featured || []),
    ...(SHOP_ITEMS.money || []),
    ...(SHOP_ITEMS.premium || [])
  ];
}

function getStripeProductName(session) {
  const itemId =
    session.itemId ||
    session.metadata?.itemId ||
    session.client_reference_id;

  const itemById = getAllShopItems().find(i => i.id === itemId);
  if (itemById) return itemById.title;

  const itemByPrice = getAllShopItems().find(i => i.priceId === session.price);
  if (itemByPrice) return itemByPrice.title;

  return "Produit inconnu";
}

function getStripeStatus(session) {
  if (session.payment_status === "paid") return "Payé";
  if (session.status === "complete") return "Terminé";
  if (session.status === "open") return "En attente";
  if (session.status === "expired") return "Expiré";
  if (session.url) return "Session créée";
  return "Inconnu";
}

function formatDateTime(value) {
  if (!value) return "Date inconnue";

  let date;

  if (typeof value === "number") {
    date = new Date(value);
  } else if (value?.seconds) {
    date = new Date(value.seconds * 1000);
  } else {
    date = new Date(value);
  }

  if (isNaN(date.getTime())) return "Date inconnue";

  return date.toLocaleString("fr-FR");
}

function renderAdminHistory(uid, history = []) {
  const page = adminHistoryPages[uid] || 1;
  const totalPages = Math.max(1, Math.ceil(history.length / ADMIN_HISTORY_PER_PAGE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  adminHistoryPages[uid] = safePage;

  const start = (safePage - 1) * ADMIN_HISTORY_PER_PAGE;
  const items = history.slice(start, start + ADMIN_HISTORY_PER_PAGE);

  return `
    <div class="list-item">
      ${
        items.length
          ? items.map(item => `<div style="margin-bottom:6px;">${escapeHtml(item)}</div>`).join("")
          : "Aucun historique."
      }
    </div>

    <div class="row" style="margin-top:10px;">
      <button onclick="adminHistoryPrev('${uid}')">◀ Précédent</button>
      <span class="small">Page ${safePage} / ${totalPages}</span>
      <button onclick="adminHistoryNext('${uid}')">Suivant ▶</button>
    </div>
  `;
}

window.adminHistoryPrev = async function(uid) {
  adminHistoryPages[uid] = Math.max(1, (adminHistoryPages[uid] || 1) - 1);
  await renderAdmin({ uid: currentAdminUid });
};

window.adminHistoryNext = async function(uid) {
  adminHistoryPages[uid] = (adminHistoryPages[uid] || 1) + 1;
  await renderAdmin({ uid: currentAdminUid });
};

/* ================= SHOP ================= */

async function startStripeCheckout(uid, priceId, itemId, mode = "payment") {
  const baseUrl =
    window.location.origin +
    window.location.pathname.substring(0, window.location.pathname.lastIndexOf("/") + 1);

  const sessionRef = await addDoc(
    collection(db, "customers", uid, "checkout_sessions"),
    {
      mode,
      price: priceId,
      allow_promotion_codes: true,
      success_url: baseUrl + "success.html?item=" + itemId + "&session_id={CHECKOUT_SESSION_ID}",
      cancel_url: baseUrl + "boutique.html",

      itemId: itemId,
      client_reference_id: itemId,

      metadata: {
        itemId: itemId,
        productId: itemId,
        uid: uid
      }
    }
  );

  onSnapshot(sessionRef, (snap) => {
    const data = snap.data();

    if (data?.error) {
      showToast(data.error.message, "error");
    }

    if (data?.url) {
      window.location.assign(data.url);
    }
  });
}



const SHOP_ITEMS = {
  featured: [
    {
      id: "daily_gift",
      title: "Cadeau du jour",
      subtitle: "Récompense gratuite toutes les 24h",
      priceLabel: "Gratuit",
      type: "free",
      rewardType: "dailyGift",
      badge: "Journalier",
      visual: "🎁"
    },
    {
      id: "boost_x2_30s_fake",
      title: "x2 argent",
      subtitle: "(30 sec)",
      priceLabel: "Acheter pour 100 000 € (jeu)",
      type: "fake",
      fakePrice: 100000,
      rewardType: "timedMultiplier",
      rewardValue: 2,
      rewardDurationMs: 30 * 1000,
      badge: "Boost",
      visual: "⚡"
    },
    {
      id: "boost_x5_life_real",
      title: "x5 à vie",
      subtitle: "Boost permanent",
      priceLabel: "Acheter pour 1,99 €",
      type: "real",
      realPrice : "1.99 €",
      priceId: "price_1TO3M00fIfhAjnNb8ANXBtUu",
      rewardType: "permanentMultiplier",
      rewardValue: 5,
      badge: "À vie",
      visual: "5X"
    },
    {
      id: "autoclicker_real",
      title: "Auto Clicker",
      subtitle: "1 clic toutes les 0,5 sec",
      priceLabel: "Acheter pour 7,99 €",
      type: "real",
      realPrice : "7.99 €",
      priceId: "price_1TO3Os0fIfhAjnNbL7Vqebr9",
      rewardType: "autoclicker",
      badge: "Automatique",
      visual: "☄️"
    },
    {
      id: "premium_subscription",
      title: "Abonnement Premium",
      subtitle: "-15% boutique + 100 000 € chaque mois",
      priceLabel: "4,99 € / mois",
      type: "subscription",
      priceId: "price_TON_PRICE_ID_ICI",
      rewardType: "premiumSubscription",
      badge: "Mensuel",
      visual: "👑"
    }
  ],

  money: [
    { id: "money_10k", title: "10 000 €", realPrice : "0.99 €", priceId: "price_1TO3TV0fIfhAjnNbDvaGrLBF", type: "real", rewardType: "money", rewardValue: 10000, visual: "🪙" },
    { id: "money_100k", title: "100 000 €", realPrice : "2.99 €", priceId: "price_1TO3UY0fIfhAjnNbkmD55COR", type: "real", rewardType: "money", rewardValue: 100000, visual: "💰" },
    { id: "money_1m", title: "1 000 000 €", realPrice : "5.99 €", priceId: "price_1TO3VM0fIfhAjnNbaQjQaYbM", type: "real", rewardType: "money", rewardValue: 1000000, visual: "💸" },
    { id: "money_10m", title: "10 000 000 €", realPrice : "9.99 €", priceId: "price_1TO3WQ0fIfhAjnNbAhQT8htp", type: "real", rewardType: "money", rewardValue: 10000000, visual: "🏦" }
  ],

  premium: [
    {
      id: "starter_pack_real",
      title: "Pack Débutant",
      subtitle: "1 semaine de boost + 1 000 000 €",
      priceLabel: "2,99 €",
      type: "real",
      realPrice: 2.99,
      priceId: "TON_PRICE_ID_STRIPE",
      rewardType: "starterPack",
      badge: "Limité",
      visual: "🎁",
      limitedToDays: 2
    },
    {
      id: "gold_card_fake",
      title: "Carte Gold",
      subtitle: "Carte premium en faux argent",
      priceLabel: "1 000 000 € (jeu)",
      type: "fake",
      fakePrice: 1000000,
      rewardType: "cardType",
      rewardValue: "premium",
      theme: "gold",
      visual: "💳"
    },
    {
      id: "black_pack_real",
      title: "Pack Black + x2 à vie",
      subtitle: "Carte black + multiplicateur permanent",
      priceLabel: "5,99 €",
      type: "real",
      realPrice : "5.99 €",
      priceId: "price_1TO3Pv0fIfhAjnNb4ktc4YrG",
      rewardType: "blackPack",
      theme: "dark",
      visual: "🖤"
    },
    {
      id: "visual_pack_real",
      title: "Pack Premium Visuel",
      subtitle: "Pack cosmétique exclusif",
      priceLabel: "15,99 €",
      type: "real",
      realPrice : "15.99 €",
      priceId: "price_1TO3R10fIfhAjnNbF0pPBiti",
      rewardType: "visualPack",
      theme: "visual",
      visual: "🃏"
    },
    {
      id: "boost_x10_life_real",
      title: "x10 à vie",
      subtitle: "Boost permanent ultime",
      priceLabel: "5,99 €",
      type: "real",
      realPrice : "5.99 €",
      priceId: "price_1TO3Nu0fIfhAjnNbV0oos4qG",
      rewardType: "permanentMultiplier",
      rewardValue: 10,
      theme: "dark",
      visual: "10X"
    },
    {
      id: "theme_default",
      title: "Thème Original",
      subtitle: "Revenir au thème bleu classique",
      priceLabel: "Gratuit",
      type: "free",
      rewardType: "theme",
      rewardValue: "default",
      badge: "Base",
      visual: "🔵"
    },
    {
      id: "theme_pink_fake",
      title: "Thème Rose",
      subtitle: "Change les couleurs de l’interface",
      priceLabel: "250 000 € (jeu)",
      type: "fake",
      fakePrice: 250000,
      rewardType: "theme",
      rewardValue: "pink",
      badge: "Skin",
      visual: "🌸"
    },
    {
      id: "theme_gold_fake",
      title: "Thème Or",
      subtitle: "Interface luxe dorée",
      priceLabel: "750 000 € (jeu)",
      type: "fake",
      fakePrice: 750000,
      rewardType: "theme",
      rewardValue: "gold",
      badge: "Skin",
      visual: "🏆"
    },
    {
      id: "theme_red_fake",
      title: "Thème Rouge",
      subtitle: "Interface rouge néon",
      priceLabel: "500 000 € (jeu)",
      type: "fake",
      fakePrice: 500000,
      rewardType: "theme",
      rewardValue: "red",
      badge: "Skin",
      visual: "🔴"
    },
    {
      id: "theme_purple_fake",
      title: "Thème Violet",
      subtitle: "Interface violette premium",
      priceLabel: "500 000 € (jeu)",
      type: "fake",
      fakePrice: 500000,
      rewardType: "theme",
      rewardValue: "purple",
      badge: "Skin",
      visual: "🟣"
    },
    {
      id: "theme_white_fake",
      title: "Thème Blanc",
      subtitle: "Interface claire premium",
      priceLabel: "1 000 000 € (jeu)",
      type: "fake",
      fakePrice: 1000000,
      rewardType: "theme",
      rewardValue: "white",
      badge: "Skin",
      visual: "🤍"
    }
  ]
}

const LIMITED_OFFERS = [
  {
    id: "limited_boost_x5_10min",
    title: "Flash Boost x5",
    subtitle: "x5 pendant 10 minutes",
    priceLabel: "250 000 € (jeu)",
    type: "fake",
    fakePrice: 250000,
    rewardType: "limitedTimedMultiplier",
    rewardValue: 5,
    rewardDurationMs: 10 * 60 * 1000,
    badge: "Offre limitée",
    visual: "🔥",
    durationMs: 2 * 60 * 60 * 1000
  },
  {
    id: "limited_money_pack",
    title: "Pack Express",
    subtitle: "+500 000 € jeu",
    priceLabel: "100 000 € (jeu)",
    type: "fake",
    fakePrice: 100000,
    rewardType: "limitedMoney",
    rewardValue: 500000,
    badge: "Flash",
    visual: "💸",
    durationMs: 2 * 60 * 60 * 1000
  },
  {
    id: "limited_crypto_btc",
    title: "Mini Pack BTC",
    subtitle: "+1 BTC",
    priceLabel: "20 000 € (jeu)",
    type: "fake",
    fakePrice: 20000,
    rewardType: "limitedCrypto",
    asset: "BTC",
    quantity: 1,
    badge: "Crypto",
    visual: "₿",
    durationMs: 2 * 60 * 60 * 1000
  }
];

function getCurrentLimitedOffer() {
  const cycleMs = 2 * 60 * 60 * 1000;
  const index = Math.floor(Date.now() / cycleMs) % LIMITED_OFFERS.length;
  const offer = LIMITED_OFFERS[index];

  const cycleStart = Math.floor(Date.now() / cycleMs) * cycleMs;
  const endAt = cycleStart + cycleMs;

  return {
    ...offer,
    endAt
  };
}

function formatRemainingTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function buildShopCard(item, variant = "featured", profile = null) {
  let limitedTimerHtml = "";
  const ownsItem = (() => {
    if (!profile) return false;
    if (profile.isAdmin) return true;

    switch (item.rewardType) {
      case "autoclicker":
        return !!profile.shop?.autoClicker;
      case "cardType":
        if (item.rewardValue === "premium") return !!profile.shop?.ownsGoldCard;
        if (item.rewardValue === "black") return !!profile.shop?.ownsBlackCard;
        return false;
      case "blackPack":
        return !!profile.shop?.ownsBlackCard && (profile.shop?.permanentMultiplier || 1) >= 2;
      case "visualPack":
        return !!profile.shop?.visualPack;
      case "permanentMultiplier":
        return (profile.shop?.permanentMultiplier || 1) >= (item.rewardValue || 1);
      case "theme":
        return (
          item.rewardValue === "default" ||
          !!profile.shop?.visualPack ||
          (profile.shop?.ownedThemes || []).includes(item.rewardValue)
        );
      default:
        return false;
    }
  })();

  const isTheme = item.rewardType === "theme";
  const isActiveTheme =
    isTheme &&
    (
      (item.rewardValue === "default" && !profile?.shop?.activeTheme) ||
      profile?.shop?.activeTheme === item.rewardValue
    );

  if (item.id === "starter_pack_real" && profile?.createdAt) {
    const endAt = profile.createdAt + 2 * 24 * 60 * 60 * 1000;
    const remaining = endAt - Date.now();

    if (remaining > 0) {
      limitedTimerHtml = `
        <div class="shop-note">
          ⏳ Disponible encore : ${formatRemainingTime(remaining)}
        </div>
      `;
    } else {
      limitedTimerHtml = `
        <div class="shop-note">
          Offre expirée
        </div>
      `;
    }
  }

  const extraClasses = [
    "shop-card",
    variant === "money" ? "small" : "",
    item.theme === "gold" ? "gold" : "",
    item.theme === "dark" ? "dark" : "",
    item.theme === "visual" ? "visual" : "",
    ownsItem ? "owned" : ""
  ].filter(Boolean).join(" ");

  let buttonHtml = `<button class="buy-shop-item-btn" data-item-id="${escapeHtml(item.id)}">Acheter</button>`;

  if (ownsItem) {
    if (isTheme) {
      buttonHtml = `
        <button class="buy-shop-item-btn" data-item-id="${escapeHtml(item.id)}">
          ${isActiveTheme ? "Actif" : "Appliquer"}
        </button>
      `;
    } else {
      buttonHtml = `<button disabled>Déjà possédé</button>`;
    }
  }

  if (item.rewardType === "dailyGift" && profile) {
    const now = Date.now();
    const last = profile.lastDailyBonus || 0;
    const next = last + (24 * 60 * 60 * 1000);
    const available = now >= next;

    if (available) {
      buttonHtml = `<button class="buy-shop-item-btn" data-item-id="${escapeHtml(item.id)}">Récupérer</button>`;
    } else {
      const remaining = next - now;
      const hours = Math.floor(remaining / 3600000);
      const minutes = Math.floor((remaining % 3600000) / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000);

      buttonHtml = `<button disabled>Dans ${hours}h ${minutes}m ${seconds}s</button>`;
    }
  }

  return `
    <div class="${extraClasses}">
      ${ownsItem ? `<div class="shop-owned-badge">Possédé</div>` : ""}
      <div>
        <div class="shop-badge">${escapeHtml(item.badge || (item.type === "fake" ? "En jeu" : "Premium"))}</div>
        <h3>${escapeHtml(item.title)}</h3>
        ${item.subtitle ? `<div class="shop-subtitle">${escapeHtml(item.subtitle)}</div>` : ""}
        <div class="shop-price">${escapeHtml(item.priceLabel)}</div>
        ${limitedTimerHtml}
        ${
          item.type === "real"
            ? `<div class="shop-note">Paiement • Avec Stripe</div>`
            : item.type === "free"
            ? `<div class="shop-note">Récompense gratuite</div>`
            : `<div class="shop-note">Achat avec argent du jeu</div>`
        }
      </div>

      <div>
        <div class="shop-visual ${item.rewardType === "visualPack" ? "cards" : ""}">${escapeHtml(item.visual || "✨")}</div>
        ${buttonHtml}
      </div>
    </div>
  `;
}

async function purchaseShopItem(uid, itemId) {
  const profile = await getUserProfile(uid);
  if (!profile) return;
  applyUserTheme(profile);

  const limitedOffer = getCurrentLimitedOffer();

  const allItems = [
    ...SHOP_ITEMS.featured,
    ...SHOP_ITEMS.money,
    ...SHOP_ITEMS.premium,
    limitedOffer
  ];

  const item = allItems.find(i => i.id === itemId);

  if (!item) return;

  const activeAccount = profile.activeAccount || "Principal";
  const discountPercent = profile.shop?.premiumSubscription ? 15 : 0;
  profile.accounts = profile.accounts || { Principal: 0 };
  profile.history = profile.history || [];
  profile.card = profile.card || { blocked: false, revealed: false, type: "classic" };
  profile.shop = profile.shop || {};
  profile.shop.claimedLimitedOffers = profile.shop.claimedLimitedOffers || [];
  profile.boost = profile.boost || { doubleMoneyUntil: 0 };
  profile.createdAt = profile.createdAt || Date.now();

  if (item.limitedToDays) {
    const visible = (Date.now() - profile.createdAt) < (item.limitedToDays * 24 * 60 * 60 * 1000);
    if (!visible) {
      showToast("Cette offre n'est plus disponible.", "warning");
      return;
    }
  }

  if (item.rewardType === "theme") {
    profile.shop = profile.shop || {};
    profile.shop.ownedThemes = profile.shop.ownedThemes || ["default"];

    const alreadyOwned =
      profile.shop.ownedThemes.includes(item.rewardValue) ||
      profile.shop.visualPack ||
      item.rewardValue === "default";

    if (alreadyOwned) {
      item.type = "free";
    }
  }

  if (item.type === "fake") {
    const balance = profile.accounts[activeAccount] || 0;
    const inflation = getInflationMultiplier(profile);
    const baseFakePrice = item.fakePrice || 0;
    const discountPercent = profile.shop?.premiumSubscription ? 15 : 0;

    const finalFakePrice = Math.round(baseFakePrice * inflation * (1 - discountPercent / 100));

    if (balance < finalFakePrice) {
      alert(`Pas assez d'argent du jeu. Prix : ${formatMoney(finalFakePrice)}`);
      return;
    }

    profile.accounts[activeAccount] = balance - finalFakePrice;
  }

  switch (item.rewardType) {
    case "timedMultiplier": {
      const currentBoostEnd = profile.boost.doubleMoneyUntil || 0;
      const startAt = Math.max(Date.now(), currentBoostEnd);
      profile.boost.doubleMoneyUntil = startAt + (item.rewardDurationMs || 0);
      profile.history.unshift(`Achat boutique : ${item.title}`);
      break;
    }

    case "dailyGift": {
      const now = Date.now();
      const oneDay = 24 * 60 * 60 * 1000;

      if ((now - (profile.lastDailyBonus || 0)) < oneDay) {
        showToast("Cadeau déjà récupéré.", "warning");
        return;
      }

      const reward = getRandomDailyReward();

      if (reward.type === "money") {
        profile.accounts[activeAccount] = (profile.accounts[activeAccount] || 0) + reward.value;
      }

      if (reward.type === "boost") {
        profile.boost.doubleMoneyUntil = Date.now() + reward.durationMs;
      }

      if (reward.type === "crypto") {
        profile.crypto = profile.crypto || { currentAsset: "BTC", assets: {} };

        if (!profile.crypto.assets[reward.asset]) {
          profile.crypto.assets[reward.asset] = {
            price: 0,
            owned: 0,
            avgBuyPrice: 0,
            history: [],
            transactions: []
          };
        }

        profile.crypto.assets[reward.asset].owned =
          (profile.crypto.assets[reward.asset].owned || 0) + reward.quantity;
      }

      profile.lastDailyBonus = now;
      profile.history.unshift(`Cadeau du jour : ${reward.label}`);
      showToast(`🎁 Cadeau du jour récupéré : ${reward.label}`, "success");
      break;
    }

    case "permanentMultiplier": {
      profile.shop.permanentMultiplier = Math.max(profile.shop.permanentMultiplier || 1, item.rewardValue || 1);
      profile.history.unshift(`Achat boutique : ${item.title}`);
      break;
    }

    case "autoclicker": {
      profile.shop.autoClicker = true;
      profile.history.unshift(`Achat boutique : Auto Clicker`);
      break;
    }

    case "cardType": {
      if (item.rewardValue === "premium") {
        profile.shop.ownsGoldCard = true;
        profile.card.type = "premium";
      }
      if (item.rewardValue === "black") {
        profile.shop.ownsBlackCard = true;
        profile.card.type = "black";
      }
      profile.history.unshift(`Achat boutique : ${item.title}`);
      break;
    }

    case "blackPack": {
      profile.shop.ownsBlackCard = true;
      profile.card.type = "black";
      profile.shop.permanentMultiplier = Math.max(profile.shop.permanentMultiplier || 1, 2);
      profile.history.unshift(`Achat boutique : Pack Black + x2 à vie`);
      break;
    }

    case "visualPack": {
      profile.shop.visualPack = true;
      profile.shop.ownsGoldCard = true;
      profile.shop.ownsBlackCard = true;
      profile.shop.permanentMultiplier = Math.max(profile.shop.permanentMultiplier || 1, 2);
      profile.shop.ownedThemes = ["default", "pink", "purple", "red", "gold", "white"];
      profile.card.type = "black";

      profile.history.unshift(`Achat boutique : Pack Premium Visuel`);
      break;
    }

    case "starterPack": {
      profile.accounts[activeAccount] = (profile.accounts[activeAccount] || 0) + 1000000;
      profile.shop.starterBoostUntil = Date.now() + (7 * 24 * 60 * 60 * 1000);
      profile.shop.ownsGoldCard = true;
      profile.card.type = "premium";
      profile.history.unshift(`Achat boutique : Pack Débutant`);
      break;
    }

    case "money": {
      profile.accounts[activeAccount] = (profile.accounts[activeAccount] || 0) + (item.rewardValue || 0);
      profile.history.unshift(`Achat boutique : ${item.title}`);
      break;
    }
    case "lootbox": {
      const reward = drawLootboxReward(false);
      await applyLootboxReward(profile, reward);
      showToast(`Loot Box : ${reward.label}`, "succes");
      break;
    }

    case "megaLootbox": {
      const reward = drawLootboxReward(true);
      await applyLootboxReward(profile, reward);
      showToast(`Mega Loot Box : ${reward.label}`, "success");
      break;
    }

    case "limitedTimedMultiplier": {
      profile.shop.limitedMultiplierValue = item.rewardValue;
      profile.shop.limitedMultiplierUntil = Date.now() + item.rewardDurationMs;

      const limitedOfferKey = `${item.id}_${item.endAt}`;
      profile.shop.claimedLimitedOffers.push(limitedOfferKey);

      profile.history.unshift(`Offre limitée : ${item.title}`);
      break;
    }

    case "limitedMoney": {
      profile.accounts[activeAccount] = (profile.accounts[activeAccount] || 0) + item.rewardValue;

      const limitedOfferKey = `${item.id}_${item.endAt}`;
      profile.shop.claimedLimitedOffers.push(limitedOfferKey);

      profile.history.unshift(`Offre limitée : ${item.title} +${formatMoney(item.rewardValue)}`);
      break;
    }

    case "limitedCrypto": {
      profile.crypto = profile.crypto || { currentAsset: "BTC", assets: {} };

      if (!profile.crypto.assets[item.asset]) {
        profile.crypto.assets[item.asset] = {
          price: 0,
          owned: 0,
          avgBuyPrice: 0,
          history: [],
          transactions: []
        };
      }

      profile.crypto.assets[item.asset].owned =
        (profile.crypto.assets[item.asset].owned || 0) + item.quantity;

      const limitedOfferKey = `${item.id}_${item.endAt}`;
      profile.shop.claimedLimitedOffers.push(limitedOfferKey);


      profile.history.unshift(`Offre limitée : ${item.title}`);
      break;
    }
    case "theme": {
      profile.shop.ownedThemes = profile.shop.ownedThemes || ["default"];

      const alreadyOwned =
        profile.shop.ownedThemes.includes(item.rewardValue) ||
        profile.shop.visualPack;

      if (!alreadyOwned && item.rewardValue !== "default") {
        profile.shop.ownedThemes.push(item.rewardValue);
        profile.history.unshift(`Thème acheté : ${item.title}`);
      } else {
        profile.history.unshift(`Thème appliqué : ${item.title}`);
      }

      profile.shop.activeTheme = item.rewardValue === "default" ? null : item.rewardValue;

      break;
    }
  }

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    history: profile.history,
    boost: profile.boost,
    card: profile.card,
    shop: profile.shop,
    crypto: profile.crypto,
    lastDailyBonus: profile.lastDailyBonus,
    badges: profile.badges,
  });

  showToast("Achat réussi.", "succes");
  await renderShop(uid);
}

async function renderShop(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;
  applyUserTheme(profile);

  ensureAdminOwnsEverything(profile);
  document.body.classList.toggle("visual-premium", !!profile.shop?.visualPack || !!profile.isAdmin);

  updateAdminNavVisibility(profile);

  const featuredShop = document.getElementById("featuredShop");
  const moneyPacksGrid = document.getElementById("moneyPacksGrid");
  const premiumPacksGrid = document.getElementById("premiumPacksGrid");
  const limitedOfferBox = document.getElementById("limitedOfferBox");
  const limitedOfferTimer = document.getElementById("limitedOfferTimer");
  const lootboxGrid = document.getElementById("lootboxGrid");

  const now = Date.now();
  const createdAt = profile.createdAt || now;

  const featuredItems = SHOP_ITEMS.featured.filter(item => {
    if (!item.limitedToDays) return true;
    return (now - createdAt) < (item.limitedToDays * 24 * 60 * 60 * 1000);
  });

  if (featuredShop) {
    featuredShop.innerHTML = featuredItems.map(item => buildShopCard(item, "featured", profile)).join("");
  }

  if (moneyPacksGrid) {
    moneyPacksGrid.innerHTML = SHOP_ITEMS.money.map(item => buildShopCard(item, "money", profile)).join("");
  }

  if (premiumPacksGrid) {
    const accountCreatedAt = profile.createdAt || profile.creationTime || Date.now();

    const premiumItems = SHOP_ITEMS.premium.filter(item => {
      if (!item.limitedToDays) return true;

      const endAt = accountCreatedAt + item.limitedToDays * 24 * 60 * 60 * 1000;
      return Date.now() < endAt;
    });

    premiumPacksGrid.innerHTML = premiumItems
      .map(item => buildShopCard(item, "premium", profile))
      .join("");
  }

  const limitedOffer = getCurrentLimitedOffer();
  const limitedOfferKey = `${limitedOffer.id}_${limitedOffer.endAt}`;
  const claimedLimitedOffers = profile.shop?.claimedLimitedOffers || [];
  const alreadyClaimedLimitedOffer = claimedLimitedOffers.includes(limitedOfferKey);

  if (limitedOfferTimer) {
    if (alreadyClaimedLimitedOffer) {
      limitedOfferTimer.innerText = `Offre limitée déjà achetée`;
    } else {
      limitedOfferTimer.innerText = `Expire dans ${formatRemainingTime(limitedOffer.endAt - Date.now())}`;
    }
  }

  if (limitedOfferBox) {
    if (alreadyClaimedLimitedOffer) {
      limitedOfferBox.innerHTML = `
        <div class="card">
          <h3>✅ Offre limitée récupérée</h3>
          <p class="small">Tu as déjà acheté cette offre.</p>
          <p class="small">Prochaine offre dans ${formatRemainingTime(limitedOffer.endAt - Date.now())}</p>
        </div>
      `;
    } else {
      limitedOfferBox.innerHTML = buildShopCard(limitedOffer, "featured", profile);
    }
  }

  if (lootboxGrid) {
    lootboxGrid.innerHTML = LOOTBOX_SHOP_ITEMS.map(item => `
      <div class="shop-card lootbox-card">
        <div>
          <div class="shop-badge">${escapeHtml(item.badge)}</div>
          <h3>${escapeHtml(item.title)}</h3>
          <div class="shop-subtitle">${escapeHtml(item.subtitle)}</div>
          <div class="shop-price">${escapeHtml(item.priceLabel)}</div>
          <div class="shop-note">${item.type === "real" ? "Paiement Stripe" : "Achat avec argent du jeu"}</div>
        </div>

        <div>
          <div class="shop-visual">${escapeHtml(item.visual)}</div>
          <div class="lootbox-card-actions">
            <button class="buy-lootbox-btn" data-item-id="${escapeHtml(item.id)}">Ouvrir</button>
            <button class="secondary lootbox-info-btn" data-item-id="${escapeHtml(item.id)}">?</button>
          </div>
        </div>
      </div>
    `).join("");
  }

  document.querySelectorAll(".lootbox-info-btn").forEach(btn => {
    btn.onclick = () => {
      const item = LOOTBOX_SHOP_ITEMS.find(i => i.id === btn.dataset.itemId);
      if (item) openLootboxInfo(item);
    };
  });

  document.querySelectorAll(".buy-lootbox-btn").forEach(btn => {
    btn.onclick = async () => {
      const item = LOOTBOX_SHOP_ITEMS.find(i => i.id === btn.dataset.itemId);
      if (!item) return;

      if (item.type === "real") {
        await startStripeCheckout(uid, item.priceId, item.id, "payment");
        return;
      }

      const profile = await getUserProfile(uid);
      const activeAccount = profile.activeAccount || "Principal";
      const balance = profile.accounts?.[activeAccount] || 0;

      if (balance < item.fakePrice) {
        showToast("Pas assez d'argent du jeu.", "error");
        return;
      }

      profile.accounts[activeAccount] = balance - item.fakePrice;
      profile.history = profile.history || [];
      profile.history.unshift(`Achat lootbox : ${item.title} -${formatMoney(item.fakePrice)}`);

      await updateUserProfile(uid, {
        accounts: profile.accounts,
        history: profile.history,
        badges: profile.badges,
      });

      await openLootboxWithAnimation(uid, item);
    };
  });

  document.querySelectorAll(".buy-shop-item-btn").forEach(btn => {
    btn.onclick = async () => {
      const itemId = btn.dataset.itemId;

      const limitedOffer = getCurrentLimitedOffer();

      const allItems = [
        ...SHOP_ITEMS.featured,
        ...SHOP_ITEMS.money,
        ...SHOP_ITEMS.premium,
        limitedOffer
      ];

      const item = allItems.find(i => i.id === itemId);

      if (!item) {
        alert("Produit introuvable.");
        return;
      }

      if (item.type === "real") {
        if (!item.priceId) {
          alert("Erreur : priceId Stripe manquant.");
          return;
        }

        await startStripeCheckout(uid, item.priceId, item.id, "payment");
        return;
      }

      if (item.type === "subscription") {
        if (!item.priceId) {
          alert("Erreur : priceId Stripe manquant.");
          return;
        }

        await startStripeCheckout(uid, item.priceId, item.id, "subscription");
        return;
      }

      await purchaseShopItem(uid, item.id);
    };
  });
}

async function initShop(user) {
  bindNewsPopup(user.uid);
  bindLogout();
  setInterval(async () => {
    await checkUnreadNews(user.uid);
  }, 5000);
  await renderShop(user.uid);
  bindLootboxModals();
}

/* ================= LEADERBOARD ================= */

function getUserNetWorth(user) {
  const money = Object.values(user.accounts || {}).reduce((sum, value) => sum + Number(value || 0), 0);

  let crypto = 0;
  Object.values(user.crypto?.assets || {}).forEach(asset => {
    crypto += (asset.owned || 0) * (asset.price || 0);
  });

  let investmentsValue = 0;
  Object.entries(user.investments || {}).forEach(([id, qty]) => {
    const inv = INVESTMENTS.find(i => i.id === id);
    if (inv) investmentsValue += inv.cost * Number(qty || 0);
  });

  return money + crypto + investmentsValue;
}

function getCryptoValue(user) {
  let crypto = 0;
  Object.values(user.crypto?.assets || {}).forEach(asset => {
    crypto += (asset.owned || 0) * (asset.price || 0);
  });
  return crypto;
}

function getLeaderboardValue(user, type) {
  if (type === "wealth") return getUserNetWorth(user);
  if (type === "clicks") return Number(user.totalClicks || 0);
  if (type === "passive") return getTotalPassiveIncome(user);
  if (type === "crypto") return getCryptoValue(user);
  if (type === "prestige") return Number(user.prestige?.level || 0);
  return 0;
}

function getLeaderboardTitle(type) {
  if (type === "wealth") return "Top richesse";
  if (type === "clicks") return "Top clicks";
  if (type === "passive") return "Top revenus passifs";
  if (type === "crypto") return "Top portefeuille crypto";
  if (type === "prestige") return "Top prestige";
  return "Classement";
}

function formatLeaderboardValue(value, type) {
  if (type === "clicks") {
    return Number(value || 0).toLocaleString("fr-FR") + " clicks";
  }

  if (type === "passive") {
    return formatMoney(value) + " / sec";
  }

  if (type === "prestige") {
    return `Prestige ${Number(value || 0).toLocaleString("fr-FR")}`;
  }

  return formatMoney(value);
}

async function renderLeaderboard(uid) {
  const currentProfile = await getUserProfile(uid);
  updateAdminNavVisibility(currentProfile);

  const leaderboardList = document.getElementById("leaderboardList");
  const leaderboardTitle = document.getElementById("leaderboardTitle");

  if (!leaderboardList) return;

  const users = await getAllUsers();

  const ranking = users
    .filter(user => !user.isAdmin)
    .map(user => {
      const badgesHtml = (user.badges || [])
        .slice(0, 3)
        .map(id => {
          const b = BADGES.find(x => x.id === id);
          return b ? `<span class="lb-badge big ${b.rarity || "common"}" title="${escapeHtml(b.name)}">${b.icon}</span>` : "";
        })
        .join("");

      return {
        uid: user.uid,
        rawUser: user,
        name: user.displayName || user.username || user.email || "Joueur",
        isCurrentUser: user.uid === uid,
        value: getLeaderboardValue(user, currentLeaderboardType),
        badgesHtml
      };
    })
    .sort((a, b) => {
      if (currentLeaderboardType === "prestige") {
        if (b.value !== a.value) return b.value - a.value;
        return getUserNetWorth(b.rawUser) - getUserNetWorth(a.rawUser);
      }

      return b.value - a.value;
    })
    .slice(0, 20);

  if (leaderboardTitle) {
    leaderboardTitle.innerText = getLeaderboardTitle(currentLeaderboardType);
  }

  leaderboardList.innerHTML = ranking.map((u, index) => {
    const rank = index + 1;
    const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `#${rank}`;

    return `
      <div class="leaderboard-item ${rank === 1 ? "leaderboard-top1" : ""}">
        <div>
          <div class="leaderboard-rank">
            ${medal} ${escapeHtml(u.name)} ${u.isCurrentUser ? "• Toi" : ""}
          </div>

          <div class="lb-badges">${u.badgesHtml}</div>

          <div class="small">${getLeaderboardTitle(currentLeaderboardType)}</div>
        </div>

        <strong>${formatLeaderboardValue(u.value, currentLeaderboardType)}</strong>
      </div>
    `;
  }).join("");

  await rewardLeaderboardTop(uid, ranking);
}

async function rewardLeaderboardTop(uid, ranking) {
  if (!ranking.length) return;

  const position = ranking.findIndex(u => u.uid === uid) + 1;
  if (![1, 2, 3].includes(position)) return;

  const profile = await getUserProfile(uid);
  if (!profile) return;
  applyUserTheme(profile);

  const now = Date.now();
  const interval = 60 * 1000;
  const lastReward = profile.lastLeaderboardReward || 0;

  if (now - lastReward < interval) return;

  const activeAccount = profile.activeAccount || "Principal";
  profile.accounts = profile.accounts || { Principal: 0 };
  profile.history = profile.history || {};
  profile.shop = profile.shop || {};

  if (position === 1) {
    profile.shop.leaderboardClickMultiplierUntil = now + interval;
    profile.history = Array.isArray(profile.history) ? profile.history : [];
    profile.history.unshift("Bonus TOP 1 leaderboard : x2 clic pendant 1 min");
  }

  if (position === 2) {
    profile.accounts[activeAccount] = (profile.accounts[activeAccount] || 0) + 10000;
    profile.history = Array.isArray(profile.history) ? profile.history : [];
    profile.history.unshift("Bonus TOP 2 leaderboard +10 000 €");
  }

  if (position === 3) {
    profile.accounts[activeAccount] = (profile.accounts[activeAccount] || 0) + 1000;
    profile.history = Array.isArray(profile.history) ? profile.history : [];
    profile.history.unshift("Bonus TOP 3 leaderboard +1 000 €");
  }

  profile.lastLeaderboardReward = now;

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    shop: profile.shop,
    history: profile.history,
    lastLeaderboardReward: profile.lastLeaderboardReward,
    badges: profile.badges,
  });
}

async function initLeaderboard(user) {
  bindNewsPopup(user.uid);
  bindLogout();

  document.querySelectorAll(".leaderboard-tab").forEach(btn => {
    btn.onclick = async () => {
      document.querySelectorAll(".leaderboard-tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      currentLeaderboardType = btn.dataset.ranking || "wealth";
      await renderLeaderboard(user.uid);
    };
  });

  await renderLeaderboard(user.uid);

  setInterval(async () => {
    await checkUnreadNews(user.uid);
    await renderLeaderboard(user.uid);
  }, 5000);
}

/* ================= LOOTBOX ================= */

const LOOTBOX_REWARDS = [
  { chance: 45, type: "money", value: 5000, label: "5 000 €" },
  { chance: 25, type: "money", value: 25000, label: "25 000 €" },
  { chance: 15, type: "boost", durationMs: 60 * 1000, label: "Boost x2 pendant 1 min" },
  { chance: 10, type: "crypto", asset: "BTC", quantity: 0.0002, label: "0.0002 BTC", rarity: "rare" },
  { chance: 5, type: "money", value: 250000, label: "Jackpot 250 000 €", rarity: "legendary" }
];

const MEGA_LOOTBOX_REWARDS = [
  { chance: 35, type: "money", value: 100000, label: "100 000 €" },
  { chance: 25, type: "boost", durationMs: 5 * 60 * 1000, label: "Boost x2 pendant 5 min" },
  { chance: 20, type: "crypto", asset: "ETH", quantity: 0.05, label: "0.05 ETH" },
  { chance: 15, type: "money", value: 1000000, label: "1 000 000 €", rarity: "rare" },
  { chance: 5, type: "permanentMultiplier", value: 2, label: "x2 à vie", rarity: "legendary" }
];

function drawLootboxReward(isMega = false) {
  const table = isMega ? MEGA_LOOTBOX_REWARDS : LOOTBOX_REWARDS;
  const rand = Math.random() * 100;
  let cumulative = 0;

  for (const reward of table) {
    cumulative += reward.chance;
    if (rand <= cumulative) return reward;
  }

  return table[0];
}

async function applyLootboxReward(profile, reward) {
  const activeAccount = profile.activeAccount || "Principal";

  profile.accounts = profile.accounts || { Principal: 0 };
  profile.history = profile.history || [];
  profile.boost = profile.boost || { doubleMoneyUntil: 0 };
  profile.shop = profile.shop || {};
  profile.crypto = profile.crypto || { currentAsset: "BTC", assets: {} };

  if (reward.type === "money") {
    profile.accounts[activeAccount] = (profile.accounts[activeAccount] || 0) + reward.value;
  }

  if (reward.type === "boost") {
    const currentEnd = profile.boost.doubleMoneyUntil || 0;
    const startAt = Math.max(Date.now(), currentEnd);
    profile.boost.doubleMoneyUntil = startAt + reward.durationMs;
  }

  if (reward.type === "crypto") {
    if (!profile.crypto.assets[reward.asset]) {
      profile.crypto.assets[reward.asset] = {
        price: 0,
        owned: 0,
        avgBuyPrice: 0,
        history: [],
        transactions: []
      };
    }

    profile.crypto.assets[reward.asset].owned =
      (profile.crypto.assets[reward.asset].owned || 0) + reward.quantity;
  }

  if (reward.type === "permanentMultiplier") {
    profile.shop.permanentMultiplier = Math.max(profile.shop.permanentMultiplier || 1, reward.value);
  }

  if (reward.type === "card") {
    profile.card = profile.card || {};
    profile.shop = profile.shop || {};

    if (reward.cardType === "black") {
      profile.shop.ownsBlackCard = true;
      profile.card.type = "black";
    }

    if (reward.cardType === "premium") {
      profile.shop.ownsGoldCard = true;
      profile.card.type = "premium";
    }
  }

  if (reward.type === "visualPack") {
    profile.shop = profile.shop || {};
    profile.card = profile.card || {};

    profile.shop.visualPack = true;
    profile.shop.ownsGoldCard = true;
    profile.shop.ownsBlackCard = true;
    profile.card.type = "black";
  }

  profile.history.unshift(`Loot box : ${reward.label}`);
}

const LOOTBOX_SHOP_ITEMS = [
  {
    id: "lootbox_fake",
    title: "Loot Box",
    subtitle: "Récompense aléatoire classique",
    priceLabel: "50 000 € (jeu)",
    type: "fake",
    fakePrice: 50000,
    rewardType: "lootbox",
    badge: "Chance",
    visual: "🎁",
    table: "normal"
  },
  {
    id: "mega_lootbox_fake",
    title: "Mega Loot Box",
    subtitle: "Meilleures récompenses",
    priceLabel: "500 000 € (jeu)",
    type: "fake",
    fakePrice: 500000,
    rewardType: "megaLootbox",
    badge: "Rare",
    visual: "💎",
    table: "mega"
  },
  {
    id: "premium_lootbox_real",
    title: "Premium Loot Box",
    subtitle: "Récompenses très rares",
    priceLabel: "2,99 €",
    type: "real",
    priceId: "price_1TR0C70fIfhAjnNbKVBrvcXh",
    rewardType: "premiumLootbox",
    badge: "Premium",
    visual: "👑",
    table: "premium"
  }
];

const PREMIUM_LOOTBOX_REWARDS = [
  { chance: 30, type: "money", value: 1000000, label: "1 000 000 €" },
  { chance: 25, type: "boost", durationMs: 15 * 60 * 1000, label: "Boost x2 pendant 15 min" },
  { chance: 20, type: "crypto", asset: "BTC", quantity: 50, label: "50 BTC" },
  { chance: 15, type: "permanentMultiplier", value: 2, label: "x2 à vie" },
  { chance: 8, type: "card", cardType: "black", label: "Carte Black", rarity: "rare" },
  { chance: 2, type: "visualPack", label: "Pack Premium Visuel", rarity: "legendary" }
];

function getLootboxTable(table) {
  if (table === "mega") return MEGA_LOOTBOX_REWARDS;
  if (table === "premium") return PREMIUM_LOOTBOX_REWARDS;
  return LOOTBOX_REWARDS;
}

function drawLootboxRewardByTable(table) {
  const rewards = getLootboxTable(table);
  const rand = Math.random() * 100;
  let cumulative = 0;

  for (const reward of rewards) {
    cumulative += reward.chance;
    if (rand <= cumulative) return reward;
  }

  return rewards[0];
}

async function openLootboxWithAnimation(uid, item) {
  const modal = document.getElementById("lootboxModal");
  const animation = document.getElementById("lootboxAnimation");
  const title = document.getElementById("lootboxResultTitle");
  const text = document.getElementById("lootboxResultText");

  if (!modal || !animation || !title || !text) {
    await purchaseShopItem(uid, item.id);
    return;
  }

  modal.style.display = "flex";
  animation.className = "lootbox-animation";
  animation.innerText = item.visual || "🎁";
  title.innerText = "Ouverture...";
  text.innerText = "La récompense arrive...";

  setTimeout(async () => {
    const profile = await getUserProfile(uid);
    if (!profile) return;
    applyUserTheme(profile);

    const reward = drawLootboxRewardByTable(item.table);
    const modalContent = document.querySelector(".lootbox-modal-content");

    if (reward.rarity === "legendary") {
      modalContent?.classList.add("legendary");
    }

    await applyLootboxReward(profile, reward);

    await updateUserProfile(uid, {
      accounts: profile.accounts,
      history: profile.history,
      boost: profile.boost,
      shop: profile.shop,
      crypto: profile.crypto,
      card: profile.card,
      badges: profile.badges,
    });

    animation.classList.add(reward.rarity === "legendary" ? "legendary" : "opened");
    animation.innerText = "✨";
    title.innerText = "Récompense obtenue !";
    text.innerText = reward.label;
    showToast(`🎁 Lootbox : ${reward.label}`, "success");

    await renderShop(uid);
  }, 1600);
}

function openLootboxInfo(item) {
  const modal = document.getElementById("lootboxInfoModal");
  const content = document.getElementById("lootboxInfoContent");
  if (!modal || !content) return;

  const rewards = getLootboxTable(item.table);

  content.innerHTML = rewards.map(reward => `
    <div class="lootbox-info-row">
      <span>${escapeHtml(reward.label)}</span>
      <strong>${reward.chance}%</strong>
    </div>
  `).join("");

  modal.style.display = "flex";
}

function bindLootboxModals() {
  const closeLootboxModalBtn = document.getElementById("closeLootboxModalBtn");
  const closeLootboxInfoBtn = document.getElementById("closeLootboxInfoBtn");
  const lootboxModal = document.getElementById("lootboxModal");
  const lootboxInfoModal = document.getElementById("lootboxInfoModal");

  if (closeLootboxModalBtn) {
    closeLootboxModalBtn.onclick = () => {
      if (lootboxModal) lootboxModal.style.display = "none";
    };
  }
  document.querySelector(".lootbox-modal-content")?.classList.remove("legendary");

  if (closeLootboxInfoBtn) {
    closeLootboxInfoBtn.onclick = () => {
      if (lootboxInfoModal) lootboxInfoModal.style.display = "none";
    };
  }
}

/* ================= INVESTMENTS PAGE ================= */


async function renderInvestmentsPage(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;
  applyUserTheme(profile);

  updateAdminNavVisibility(profile);

  const balanceEl = document.getElementById("investmentBalance");
  const incomeEl = document.getElementById("investmentIncomeInfo");
  const grid = document.getElementById("investmentsShop");

  const activeAccount = profile.activeAccount || "Principal";
  const balance = profile.accounts?.[activeAccount] || 0;
  const totalIncome = getTotalPassiveIncome(profile);

  if (balanceEl) balanceEl.innerText = `Solde : ${formatMoney(balance)}`;
  if (incomeEl) incomeEl.innerText = `Revenus passifs : ${formatMoney(totalIncome)} / sec`;

  profile.investments = profile.investments || {};

  if (grid) {
    grid.innerHTML = INVESTMENTS.map(inv => {
      const qty = profile.investments[inv.id] || 0;
      const finalCost = Math.round(inv.cost * getInflationMultiplier(profile));
      const canBuy = balance >= finalCost;

      return `
        <div class="investment-card">
          ${qty > 0 ? `<div class="investment-owned">x${qty}</div>` : ""}

          <div>
            <div class="investment-emoji">${inv.emoji}</div>
            <h3>${escapeHtml(inv.name)}</h3>
            <p class="small">Génère automatiquement de l'argent.</p>

            <div class="investment-stats">
              <div class="investment-stat">
                Prix : <strong>${formatMoney(finalCost)}</strong>
              </div>
              <div class="investment-stat">
                Gain : <strong>${formatMoney(inv.incomePerSecond)} / sec</strong>
              </div>
              <div class="investment-stat">
                Revenu actuel : <strong>${formatMoney(qty * inv.incomePerSecond)} / sec</strong>
              </div>
            </div>
          </div>

          <button class="buy-investment-page-btn" data-investment-id="${inv.id}" ${canBuy ? "" : "disabled"}>
            ${canBuy ? "Acheter" : "Pas assez d'argent"}
          </button>
        </div>
      `;
    }).join("");
  }

  document.querySelectorAll(".buy-investment-page-btn").forEach(btn => {
    btn.onclick = async () => {
      await buyInvestment(uid, btn.dataset.investmentId);
      await renderInvestmentsPage(uid);
    };
  });
}

async function initInvestments(user) {
  bindLogout();
  await renderInvestmentsPage(user.uid);

  setInterval(async () => {
    await applyPassiveIncome(user.uid);
    await renderInvestmentsPage(user.uid);
    await checkUnreadNews(user.uid);
  }, 1000);
}

/* ============= Mission ============== */

const MISSIONS = [
  {
    id: "click_100",
    title: "Cliqueur débutant",
    description: "Atteindre 100 clics",
    reward: 5000,
    check: profile => (profile.totalClicks || 0) >= 100
  },
  {
    id: "click_1000",
    title: "Cliqueur confirmé",
    description: "Atteindre 1 000 clics",
    reward: 50000,
    check: profile => (profile.totalClicks || 0) >= 1000
  },
  {
    id: "first_crypto",
    title: "Premier investisseur",
    description: "Acheter ta première crypto/action",
    reward: 10000,
    check: profile => Object.values(profile.crypto?.assets || {}).some(a => (a.owned || 0) > 0)
  },
  {
    id: "passive_1000",
    title: "Revenus automatiques",
    description: "Atteindre 1 000 €/sec de revenus passifs",
    reward: 100000,
    check: profile => getTotalPassiveIncome(profile) >= 1000
  },
  {
    id: "millionaire",
    title: "Millionnaire",
    description: "Atteindre 1 000 000 € de richesse totale",
    reward: 250000,
    check: profile => getUserNetWorth(profile) >= 1000000
  },
  {
    id: "milliardaire",
    title: "Millairdaire",
    description: "Atteindre 1 000 000 000 € de richesse totale",
    reward: 1000000,
    check: profile => getUserNetWorth(profile) >= 1000000000
  },
  {
    id: "level_10",
    title: "Banquier expérimenté",
    description: "Atteindre le niveau 10",
    reward: 250000,
    check: profile => getLevelFromXp(profile.xp || 0).level >= 10
  },
  {
    id: "level_25",
    title: "Légende financière",
    description: "Atteindre le niveau 25",
    reward: 2500000,
    check: profile => getLevelFromXp(profile.xp || 0).level >= 25
  },
  {
    id: "first_prestige",
    title: "Nouvelle vie",
    description: "Faire ton premier prestige",
    reward: 500000,
    check: profile => (profile.prestige?.level || 0) >= 1
  },
  {
    id: "prestige_5",
    title: "Légende Vivante",
    description: "Atteindre le prestige niveau 5",
    reward: 5000000,
    check: profile => (profile.prestige?.level || 0) >= 5
  }
];

async function checkAndClaimMissions(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;
  applyUserTheme(profile);

  profile.completedMissions = profile.completedMissions || [];
  profile.accounts = profile.accounts || { Principal: 0 };
  profile.history = profile.history || [];

  const activeAccount = profile.activeAccount || "Principal";
  let changed = false;

  for (const mission of MISSIONS) {
    if (profile.completedMissions.includes(mission.id)) continue;

    if (mission.check(profile)) {
      profile.completedMissions.push(mission.id);
      profile.accounts[activeAccount] = (profile.accounts[activeAccount] || 0) + mission.reward;
      profile.history.unshift(`Mission réussie : ${mission.title} : +${formatMoney(mission.reward)}`);

      showToast(`🏆 Succès terminé : ${mission.title} +${formatMoney(mission.reward)}`, "success");
      addXp(profile, 250, `Mission : ${mission.title}`);
      handleBadges(profile);

      changed = true;
    }
  }

  if (changed) {
    await updateUserProfile(uid, {
      completedMissions: profile.completedMissions,
      accounts: profile.accounts,
      history: profile.history,
      xp: profile.xp,
      badges: profile.badges,
    });
  }
}

async function renderMissions(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;
  applyUserTheme(profile);

  updateAdminNavVisibility(profile);
  await checkAndClaimMissions(uid);
  await renderDailyQuests(uid);

  const freshProfile = await getUserProfile(uid);
  const prestigeInfo = document.getElementById("prestigeInfo");
  const prestigeRequirement = document.getElementById("prestigeRequirement");
  const prestigeBtn = document.getElementById("prestigeBtn");

  const prestigeLevel = freshProfile.prestige?.level || 0;
  const requirement = getPrestigeRequirement(prestigeLevel);
  const netWorth = getUserNetWorth(freshProfile);

  if (prestigeInfo) {
    prestigeInfo.innerText = `Prestige niveau ${prestigeLevel} • Bonus permanent x${getPrestigeMultiplier(freshProfile).toFixed(1)}`;
  }

  if (prestigeRequirement) {
    prestigeRequirement.innerText = `Richesse requise : ${formatMoney(requirement)} • Actuel : ${formatMoney(netWorth)}`;
  }

  if (prestigeBtn) {
    prestigeBtn.disabled = netWorth < requirement;
    prestigeBtn.onclick = async () => {
      await doPrestige(uid);
    };
  }
  const missionsList = document.getElementById("missionsList");
  if (!missionsList) return;

  const completed = freshProfile.completedMissions || [];

  missionsList.innerHTML = MISSIONS.map(mission => {
    const isDone = completed.includes(mission.id);

    return `
      <div class="mission-card ${isDone ? "completed" : ""}">
        <h3>${escapeHtml(mission.title)}</h3>
        <p class="small">${escapeHtml(mission.description)}</p>
        <p>Récompense : <strong>${formatMoney(mission.reward)}</strong></p>
        <span class="mission-status">${isDone ? "✅ Terminé" : "⏳ En cours"}</span>
      </div>
    `;
  }).join("");
}

async function initMissions(user) {
  bindNewsPopup(user.uid);
  bindLogout();
  await renderMissions(user.uid);

  setInterval(async () => {
    await checkUnreadNews(user.uid);
    await renderMissions(user.uid);
    await checkUnreadNews(user.uid);
  }, 1000);
}


const DAILY_QUESTS = [
  {
    id: "earn_10k",
    title: "Gagner 10 000 €",
    description: "Gagne 10 000 € aujourd’hui.",
    reward: 1000,
    target: 10000,
    type: "earnMoney"
  },
  {
    id: "click_100_daily",
    title: "Cliquer 100 fois",
    description: "Clique 100 fois aujourd’hui.",
    reward: 5000,
    target: 100,
    type: "clicks"
  },
  {
    id: "buy_crypto_daily",
    title: "Investir en crypto",
    description: "Achète une crypto ou une action aujourd’hui.",
    reward: 10000,
    target: 1,
    type: "cryptoBuy"
  },
  {
    id: "buy_investment_daily",
    title: "Acheter un investissement",
    description: "Achète un investissement passif aujourd’hui.",
    reward: 15000,
    target: 1,
    type: "investmentBuy"
  }
];

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function ensureDailyQuests(profile) {
  const today = getTodayKey();

  profile.dailyQuests = profile.dailyQuests || {};

  if (profile.dailyQuests.date !== today) {
    profile.dailyQuests = {
      date: today,
      progress: {},
      claimed: []
    };
  }

  return profile.dailyQuests;
}

function addDailyQuestProgress(profile, type, amount = 1) {
  const daily = ensureDailyQuests(profile);
  daily.progress[type] = (daily.progress[type] || 0) + amount;
}

async function renderDailyQuests(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;
  applyUserTheme(profile);

  const daily = ensureDailyQuests(profile);
  const dailyQuestsList = document.getElementById("dailyQuestsList");
  if (!dailyQuestsList) return;

  const dailyQuestTimer = document.getElementById("dailyQuestTimer");

  if (dailyQuestTimer) {
    dailyQuestTimer.innerText = `Les quêtes quotidiennes se réinitialisent dans : ${formatDailyResetTimer()}`;
  }

  dailyQuestsList.innerHTML = DAILY_QUESTS.map(quest => {
    const progress = daily.progress[quest.type] || 0;
    const percent = Math.min(100, (progress / quest.target) * 100);
    const completed = progress >= quest.target;
    const claimed = daily.claimed.includes(quest.id);

    return `
      <div class="mission-card ${completed ? "completed" : ""}">
        <h3>${escapeHtml(quest.title)}</h3>
        <p class="small">${escapeHtml(quest.description)}</p>
        <p>Progression : <strong>${Math.floor(progress)} / ${quest.target}</strong></p>
        <div style="height:10px; border-radius:999px; background:rgba(255,255,255,0.1); overflow:hidden;">
          <div style="height:100%; width:${percent}%; background:linear-gradient(90deg,#43e97b,#38f9d7);"></div>
        </div>
        <p>Récompense : <strong>${formatMoney(quest.reward)}</strong></p>
        <button class="claim-daily-quest-btn" data-quest-id="${quest.id}" ${completed && !claimed ? "" : "disabled"}>
          ${claimed ? "Réclamé" : completed ? "Récupérer" : "En cours"}
        </button>
      </div>
    `;
  }).join("");

  document.querySelectorAll(".claim-daily-quest-btn").forEach(btn => {
    btn.onclick = async () => {
      await claimDailyQuest(uid, btn.dataset.questId);
      await renderDailyQuests(uid);
    };
  });

  await updateUserProfile(uid, {
    dailyQuests: profile.dailyQuests,
    badges: profile.badges,
  });
}

async function claimDailyQuest(uid, questId) {
  const profile = await getUserProfile(uid);
  if (!profile) return;
  applyUserTheme(profile);

  const daily = ensureDailyQuests(profile);
  const quest = DAILY_QUESTS.find(q => q.id === questId);
  if (!quest) return;

  const progress = daily.progress[quest.type] || 0;
  if (progress < quest.target) {
    showToast("Quête pas encore terminée.", "error");
    return;
  }

  if (daily.claimed.includes(quest.id)) {
    showToast("Récompense déjà récupérée.", "error");
    return;
  }

  const activeAccount = profile.activeAccount || "Principal";
  profile.accounts = profile.accounts || { Principal: 0 };
  profile.history = profile.history || [];

  profile.accounts[activeAccount] = (profile.accounts[activeAccount] || 0) + quest.reward;
  daily.claimed.push(quest.id);

  profile.history.unshift(`Quête quotidienne terminée : ${quest.title} +${formatMoney(quest.reward)}`);

  addXp(profile, 100, "Quête quotidienne");
  handleBadges(profile);

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    dailyQuests: profile.dailyQuests,
    history: profile.history,
    xp: profile.xp,
    badges: profile.badges,
  });

  showToast(`✅ Quête terminée : ${quest.title} +${formatMoney(quest.reward)}`, "success");
}


function getPrestigeRequirement(level) {
  return 100_000_000 * Math.pow(5, level || 0);
}

function getPrestigeMultiplier(profile) {
  const level = profile.prestige?.level || 0;
  return 1 + level * 0.2;
}

async function doPrestige(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;
  applyUserTheme(profile);

  const netWorth = getUserNetWorth(profile);
  const currentLevel = profile.prestige?.level || 0;
  const requirement = getPrestigeRequirement(currentLevel);

  if (netWorth < requirement) {
    showToast(`Il faut ${formatMoney(requirement)} de richesse pour faire un prestige.`, "error");
    return;
  }

  const confirmPrestige = confirm(
    `Faire un prestige ? Tu vas repartir presque à zéro, mais gagner +20% de gains permanents.`
  );

  if (!confirmPrestige) return;

  profile.prestige = profile.prestige || {};
  profile.prestige.level = currentLevel + 1;
  profile.prestige.lastPrestigeAt = Date.now();

  profile.accounts = { Principal: 0 };
  profile.activeAccount = "Principal";
  profile.clickValue = 1;
  profile.clickLevel = 1;
  profile.xp = 0;
  profile.totalClicks = 0;
  profile.investments = {};
  profile.crypto = {
    currentAsset: "BTC",
    assets: {}
  };
  profile.loans = [];
  profile.boost = { doubleMoneyUntil: 0 };
  profile.history = profile.history || [];
  const prestigeMissionIdsToKeep = ["first_prestige", "prestige_5"];

  profile.completedMissions = (profile.completedMissions || []).filter(id =>
    prestigeMissionIdsToKeep.includes(id)
  );

  profile.dailyQuests = {
    date: getTodayKey(),
    progress: {},
    claimed: []
  };
  profile.history.unshift(`Prestige niveau ${profile.prestige.level} atteint`);

  await addNewsHistoryItem({
    title: "⭐ Nouveau prestige",
    description: `${profile.displayName || profile.username || "Un joueur"} vient d’atteindre le prestige niveau ${profile.prestige.level}.`,
    type: "prestige"
  });

  showToast("🔔 Nouvelle news disponible : prestige atteint !", "success");

  await updateUserProfile(uid, {
    prestige: profile.prestige,
    accounts: profile.accounts,
    activeAccount: profile.activeAccount,
    clickValue: profile.clickValue,
    clickLevel: profile.clickLevel,
    investments: profile.investments,
    crypto: profile.crypto,
    loans: profile.loans,
    boost: profile.boost,
    history: profile.history,
    completedMissions: profile.completedMissions,
    dailyQuests: profile.dailyQuests,
    totalClicks: profile.totalClicks,
    xp: profile.xp,
    badges: profile.badges,
  });

  showToast(`Prestige réussi ! Niveau ${profile.prestige.level}`, "success");
  await renderMissions(uid);
}

/* ================== NEWS =========*/

const NEWS_EVENTS = [
  {
    id: "btc_crash",
    title: "Crash brutal du Bitcoin",
    description: "Une vente massive fait chuter le BTC. Les traders paniquent.",
    type: "market",
    effects: [
      { type: "asset", asset: "BTC", percent: -25 }
    ]
  },
  {
    id: "eth_update",
    title: "Ethereum annonce une mise à jour majeure",
    description: "ETH attire de nouveaux investisseurs après une annonce technique.",
    type: "market",
    effects: [
      { type: "asset", asset: "ETH", percent: 18 }
    ]
  },
  {
    id: "apple_bad_sales",
    title: "Apple vend moins que prévu",
    description: "AAPL chute après des résultats décevants.",
    type: "market",
    effects: [
      { type: "asset", asset: "AAPL", percent: -18 }
    ]
  },
  {
    id: "tesla_hype",
    title: "Tesla annonce une nouvelle technologie",
    description: "TSLA explose après une annonce très attendue.",
    type: "market",
    effects: [
      { type: "asset", asset: "TSLA", percent: 22 }
    ]
  },
  {
    id: "nvidia_ai_boom",
    title: "Nvidia domine l’IA",
    description: "NVDA progresse fortement grâce à la demande en intelligence artificielle.",
    type: "market",
    effects: [
      { type: "asset", asset: "NVDA", percent: 20 }
    ]
  },
  {
    id: "global_crisis",
    title: "Crise économique mondiale",
    description: "Tous les marchés chutent fortement.",
    type: "market",
    effects: [
      { type: "allAssets", percent: -15 }
    ]
  },
  {
    id: "economic_boom",
    title: "Croissance économique exceptionnelle",
    description: "Les marchés repartent à la hausse.",
    type: "market",
    effects: [
      { type: "allAssets", percent: 12 }
    ]
  }
];

async function getGlobalNews() {
  const snap = await getDoc(doc(db, "game", "news"));
  return snap.exists() ? snap.data() : null;
}

async function setGlobalNews(news) {
  await setDoc(doc(db, "game", "news"), news);
}

async function triggerRandomNews() {
  const market = await ensureGlobalMarket();
  if (!market) return;

  const news = NEWS_EVENTS[Math.floor(Math.random() * NEWS_EVENTS.length)];

  if (news.effects) {
    news.effects.forEach(effect => {
      if (effect.type === "asset") {
        const asset = market.assets?.[effect.asset];
        if (!asset) return;

        asset.price = Math.max(0.01, asset.price * (1 + effect.percent / 100));
        asset.history = asset.history || [];
        asset.history.push(asset.price);
        if (asset.history.length > 30) asset.history.shift();
      }

      if (effect.type === "allAssets") {
        Object.values(market.assets || {}).forEach(asset => {
          asset.price = Math.max(0.01, asset.price * (1 + effect.percent / 100));
          asset.history = asset.history || [];
          asset.history.push(asset.price);
          if (asset.history.length > 30) asset.history.shift();
        });
      }
    });
  }

  const globalNews = {
    ...news,
    createdAt: Date.now(),
    expiresAt: Date.now() + 10 * 60 * 1000
  };

  await setGlobalMarket({
    ...market,
    updatedAt: Date.now()
  });

  await addNewsHistoryItem({
    title: globalNews.title,
    description: globalNews.description,
    type: "market"
  });
  await setGlobalNews(globalNews);
}


function showToast(message, type = "info") {
  let container = document.getElementById("toastContainer");

  if (!container) {
    container = document.createElement("div");
    container.id = "toastContainer";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = `toast ${type}`;

  // Icônes selon type
  let icon = "ℹ️";
  if (type === "success") icon = "✅";
  if (type === "error") icon = "❌";
  if (type === "warning") icon = "⚠️";
  if (type === "xp") icon = "✨";
  if (type === "level") icon = "⭐";

  toast.innerHTML = `<span class="toast-icon">${icon}</span><span>${message}</span>`;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("hide");
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

async function openNewsPopup() {
  const popup = document.getElementById("newsPopup");
  const content = document.getElementById("newsPopupContent");
  if (!popup || !content) return;

  popup.style.display = "flex";
  content.innerHTML = "Chargement...";

  const currentNews = await getGlobalNews();
  const history = await getNewsHistory();

  let html = "";

  if (currentNews) {
    html += `
      <div class="news-item">
        <h4>🔥 News active</h4>
        <h3>${escapeHtml(currentNews.title)}</h3>
        <p>${escapeHtml(currentNews.description)}</p>
        <p class="small">Expire : ${formatDateTime(currentNews.expiresAt)}</p>
      </div>
    `;
  }

  html += `<h3 style="margin-top:18px;">Historique des news</h3>`;

  if (!history.length) {
    html += `
      <div class="news-item">
        <h4>Aucune news récente</h4>
        <p class="small">Les dernières informations apparaîtront ici.</p>
      </div>
    `;
  } else {
    html += history.map(item => `
      <div class="news-item">
        <h4>${getNewsIcon(item.type)} ${escapeHtml(item.title)}</h4>
        <p>${escapeHtml(item.description)}</p>
        <p class="small">${formatDateTime(item.createdAt)}</p>
      </div>
    `).join("");
  }

  content.innerHTML = html;
}
function getNewsIcon(type) {
  if (type === "market") return "📈";
  if (type === "prestige") return "⭐";
  if (type === "leaderboard") return "🏆";
  if (type === "success") return "🎯";
  return "📰";
}

function bindNewsPopup(uid = currentUserUid) {
  const newsBellBtn = document.getElementById("newsBellBtn");
  const closeNewsPopupBtn = document.getElementById("closeNewsPopupBtn");
  const newsPopup = document.getElementById("newsPopup");

  if (newsBellBtn) {
    newsBellBtn.onclick = async () => {
      await openNewsPopup();

      if (uid) {
        await markNewsAsRead(uid);
      }
    };
  }

  if (closeNewsPopupBtn) {
    closeNewsPopupBtn.onclick = () => {
      if (newsPopup) newsPopup.style.display = "none";
    };
  }

  if (newsPopup) {
    newsPopup.onclick = (e) => {
      if (e.target === newsPopup) {
        newsPopup.style.display = "none";
      }
    };
  }

  if (uid) {
    checkUnreadNews(uid);
  }
}

async function getNewsHistory() {
  const snap = await getDoc(doc(db, "game", "newsHistory"));
  return snap.exists() ? snap.data().items || [] : [];
}

async function addNewsHistoryItem(newsItem) {
  const currentHistory = await getNewsHistory();

  const newItem = {
    id: Date.now(),
    title: newsItem.title,
    description: newsItem.description,
    type: newsItem.type || "info",
    createdAt: Date.now()
  };

  const updatedHistory = [newItem, ...currentHistory].slice(0, 10);

  await setDoc(doc(db, "game", "newsHistory"), {
    items: updatedHistory
  });

  showToast("📰 Nouvelle news disponible !", "info");

  const currentUserProfile = window.currentUserUid;
  if (currentUserProfile) {
    await checkUnreadNews(currentUserProfile);
  }
}

function getNextDailyResetTime() {
  const now = new Date();
  const next = new Date(now);

  next.setHours(24, 0, 0, 0); // minuit prochain

  return next.getTime();
}

function formatDailyResetTimer() {
  const remaining = getNextDailyResetTime() - Date.now();

  const totalSeconds = Math.max(0, Math.floor(remaining / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${hours}h ${minutes}m ${seconds}s`;
}


/* =============== ANNIMATION ================= */

function showMoneyPop(amount) {
  const container = document.getElementById("moneyPopContainer");
  if (!container) return;

  const pop = document.createElement("div");
  pop.className = "money-pop";
  pop.innerText = `+${formatMoney(amount)}`;

  pop.style.left = `${Math.random() * 45 + 30}%`;
  pop.style.top = `${Math.random() * 25 + 35}%`;

  container.appendChild(pop);

  setTimeout(() => pop.remove(), 1000);
}

function animateNumber(el, newValue, formatter = formatMoney) {
  if (!el) return;

  const oldValue = Number(el.dataset.value || 0);
  const target = Number(newValue || 0);
  const duration = 450;
  const start = performance.now();

  el.dataset.value = target;

  function frame(now) {
    const progress = Math.min(1, (now - start) / duration);
    const value = oldValue + (target - oldValue) * progress;

    el.innerText = formatter(value);

    if (progress < 1) {
      requestAnimationFrame(frame);
    }
  }

  requestAnimationFrame(frame);
}

/* ================= BADGES ================ */

const BADGES = [
  {
    id: "first_click",
    name: "Premier clic",
    desc: "Faire 1 clic",
    icon: "🖱️",
    rarity: "common",
    check: p => (p.totalClicks || 0) >= 1
  },
  {
    id: "first_100_clicks",
    name: "Cliqueur",
    desc: "Faire 100 clics",
    icon: "⚡",
    rarity: "common",
    check: p => (p.totalClicks || 0) >= 100
  },
  {
    id: "first_million",
    name: "Premier million",
    desc: "Atteindre 1 000 000 €",
    icon: "💰",
    rarity: "rare",
    check: p => getUserNetWorth(p) >= 1_000_000
  },
  {
    id: "crypto_master",
    name: "Trader",
    desc: "Acheter de la crypto ou une action",
    icon: "📈",
    rarity: "rare",
    check: p => Object.values(p.crypto?.assets || {}).some(a => (a.owned || 0) > 0)
  },
  {
    id: "investor",
    name: "Investisseur",
    desc: "Acheter un investissement passif",
    icon: "🏢",
    rarity: "rare",
    check: p => Object.keys(p.investments || {}).length > 0
  },
  {
    id: "prestige_1",
    name: "Prestige",
    desc: "Faire un prestige",
    icon: "⭐",
    rarity: "epic",
    check: p => (p.prestige?.level || 0) >= 1
  },
  {
    id: "prestige_5",
    name: "Légende prestige",
    desc: "Atteindre le prestige 5",
    icon: "👑",
    rarity: "legendary",
    check: p => (p.prestige?.level || 0) >= 5
  },
  {
    id: "level_25_badge",
    name: "Maître financier",
    desc: "Atteindre le niveau 25",
    icon: "💎",
    rarity: "legendary",
    check: p => getLevelFromXp(p.xp || 0).level >= 25
  }
];
function checkBadges(profile) {
  profile.badges = profile.badges || [];

  let newBadges = [];

  for (const badge of BADGES) {
    if (!profile.badges.includes(badge.id) && badge.check(profile)) {
      profile.badges.push(badge.id);
      newBadges.push(badge);
      if (badge.rarity === "legendary") {
        addNewsHistoryItem({
          title: "🏆 Badge légendaire débloqué",
          description: `${profile.displayName || profile.username || "Un joueur"} vient de débloquer le badge légendaire : ${badge.name}.`,
          type: "success"
        });
      }
    }
  }

  return newBadges;
}

function showBadgePopup(badge) {
  const popup = document.createElement("div");
  popup.className = "badge-popup";

  popup.innerHTML = `
    <div class="badge-popup-content">
      <div class="badge-icon">${badge.icon}</div>
      <div>
        <h3>Nouveau badge débloqué !</h3>
        <p>${badge.name}</p>
        <span>${badge.desc}</span>
      </div>
    </div>
  `;

  document.body.appendChild(popup);

  setTimeout(() => popup.classList.add("show"), 50);

  setTimeout(() => {
    popup.classList.remove("show");
    setTimeout(() => popup.remove(), 400);
  }, 4000);
}

function handleBadges(profile) {
  const newBadges = checkBadges(profile);

  newBadges.forEach(b => {
    showBadgePopup(b);
    showToast(`🎖️ Badge débloqué : ${b.name}`, "success");
  });
}


/* =================== PROFIL ============== */

async function renderProfile(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

  updateAdminNavVisibility(profile);
  applyUserTheme(profile);

  const profileAvatar = document.getElementById("profileAvatar");
  const profileName = document.getElementById("profileName");
  const profileInfo = document.getElementById("profileInfo");
  const profileStats = document.getElementById("profileStats");
  const profileBadgesGrid = document.getElementById("profileBadgesGrid");
  const badgesCount = document.getElementById("badgesCount");

  const levelData = getLevelFromXp(profile.xp || 0);
  const prestigeLevel = profile.prestige?.level || 0;
  const netWorth = getUserNetWorth(profile);
  const unlockedBadges = profile.badges || [];

  if (profileAvatar) {
    profileAvatar.innerText = prestigeLevel > 0 ? "⭐" : "👤";
  }

  if (profileName) {
    profileName.innerText = profile.displayName || profile.username || profile.email || "Joueur";
  }

  if (profileInfo) {
    profileInfo.innerText = `Niveau ${levelData.level} • Prestige ${prestigeLevel}`;
  }

  if (profileStats) {
    profileStats.innerText = `Richesse : ${formatMoney(netWorth)} • Clics : ${(profile.totalClicks || 0).toLocaleString("fr-FR")}`;
  }

  if (badgesCount) {
    badgesCount.innerText = `${unlockedBadges.length} badge(s) débloqué(s)`;
  }

  if (profileBadgesGrid) {
    profileBadgesGrid.innerHTML = BADGES.map(badge => {
      const unlocked = unlockedBadges.includes(badge.id);
      return renderBadgeCard(badge, unlocked);
    }).join("");
  }
}

async function initProfile(user) {
  bindLogout();
  bindNewsPopup(user.uid);
  await renderProfile(user.uid);
    setInterval(async () => {
    await checkUnreadNews(user.uid);
  }, 5000);
}

/* ================= BOOT ================= */

watchAuth(async (user) => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }

  currentUserUid = user.uid;
  window.currentUserUid = user.uid;

  if (page === "home") await initHome(user);
  if (page === "payments") await initPayments(user);
  if (page === "shop") await initShop(user);
  if (page === "crypto") await initCrypto(user);
  if (page === "investments") await initInvestments(user);
  if (page === "leaderboard") await initLeaderboard(user);
  if (page === "missions") await initMissions(user);
  if (page === "profile") await initProfile(user);
  if (page === "admin") await initAdmin(user);
});