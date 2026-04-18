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
  getDocs
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const page = document.body.dataset.page;
let cryptoChart = null;

/* ================= HELPERS ================= */

function formatMoney(value) {
  return `${Number(value || 0).toFixed(2)} €`;
}

function getNextUpgrade(level) {
  const upgrades = {
    1: { cost: 500, value: 10, nextLevel: 2 },
    2: { cost: 10000, value: 50, nextLevel: 3 },
    3: { cost: 100000, value: 250, nextLevel: 4 },
    4: { cost: 1000000, value: 1000, nextLevel: 5 }
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
    window.location.href = "login.html";
  };
}

/* ================= HOME ================= */

async function renderHome(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

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

  const activeAccount = profile.activeAccount || "Principal";
  const accounts = profile.accounts || { Principal: 0 };
  const balance = accounts[activeAccount] ?? 0;
  const history = profile.history || [];
  const loans = profile.loans || [];
  const boost = profile.boost || { doubleMoneyUntil: 0 };
  const clickValue = profile.clickValue || 1;
  const clickLevel = profile.clickLevel || 1;
  const now = Date.now();

  if (balanceEl) balanceEl.innerText = formatMoney(balance);
  if (welcomeEl) {
    welcomeEl.innerText = `Bienvenue ${profile.displayName || profile.username} • Compte actif : ${activeAccount}`;
  }

  const boostActive = now < (boost.doubleMoneyUntil || 0);
  const displayedClickValue = boostActive ? clickValue * 2 : clickValue;

  if (clickLevelText) {
    clickLevelText.innerText = boostActive
      ? `Gain par clic : ${displayedClickValue} € (x2 actif)`
      : `Gain par clic : ${displayedClickValue} €`;
  }

  const nextUpgrade = getNextUpgrade(clickLevel);
  if (clickUpgradeInfo) {
    clickUpgradeInfo.innerText = nextUpgrade
      ? `Niveau actuel : ${clickLevel} • Prochaine amélioration : ${nextUpgrade.cost} € pour passer à ${nextUpgrade.value} €/clic`
      : `Niveau maximal atteint`;
  }

  if (boostInfo) {
    if (boostActive) {
      const remaining = (boost.doubleMoneyUntil || 0) - now;
      const minutes = Math.floor(remaining / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000);
      boostInfo.innerText = `Boost x2 actif pendant encore ${minutes} min ${seconds} s`;
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

  if (historyEl) {
    historyEl.innerHTML = history.length
      ? history.map(item => `<div class="list-item">${item}</div>`).join("")
      : '<div class="list-item">Aucune transaction pour le moment.</div>';
  }

  if (adminAddMoneyBtn) {
    adminAddMoneyBtn.style.display = profile.isAdmin ? "inline-block" : "none";
  }
}

async function takeLoanFirebase(uid, amount) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

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

  profile.history.unshift(`Crédit obtenu +${amount.toFixed(2)} € (remboursement ${repayment.toFixed(2)} €)`);

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    loans: profile.loans,
    history: profile.history
  });

  await renderHome(uid);
}

async function repayAllLoansFirebase(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

  const activeAccount = profile.activeAccount || "Principal";
  if (!profile.accounts) profile.accounts = {};
  if (!profile.loans) profile.loans = [];
  if (!profile.history) profile.history = [];

  let balance = profile.accounts[activeAccount] || 0;
  if (profile.loans.length === 0) {
    alert("Aucun crédit à rembourser.");
    return;
  }

  const totalDebt = profile.loans.reduce((sum, loan) => sum + (loan.amountRemaining || 0), 0);
  const amountToPay = Math.min(balance, totalDebt);

  if (amountToPay <= 0) {
    alert("Pas assez d'argent.");
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
    history: profile.history
  });

  await renderHome(uid);
}

async function autoLoanPaymentFirebase(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

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
    lastLoanAutoPayment: profile.lastLoanAutoPayment
  });

  await renderHome(uid);
}

async function initHome(user) {
  bindLogout();
  await renderHome(user.uid);

  const clickBtn = byIdOrLegacy("clickBtn", 'button[onclick="clickMoney()"]');
  const bonusBtn = byIdOrLegacy("bonusBtn", 'button[onclick="claimDailyBonus()"]');
  const upgradeBtn = byIdOrLegacy("upgradeBtn", 'button[onclick="upgradeClickIncome()"]');
  const boostBtn = byIdOrLegacy("boostBtn", 'button[onclick="buyDoubleMoneyBoost()"]');
  const loan500Btn = byIdOrLegacy("loan500Btn", 'button[onclick="takeLoan(500)"]');
  const loan2000Btn = byIdOrLegacy("loan2000Btn", 'button[onclick="takeLoan(2000)"]');
  const loan10000Btn = byIdOrLegacy("loan10000Btn", 'button[onclick="takeLoan(10000)"]');
  const repayAllBtn = byIdOrLegacy("repayAllBtn", 'button[onclick="repayAllLoans()"]');
  const adminAddMoneyBtn = document.getElementById("adminAddMoneyBtn");

  if (clickBtn) {
    clickBtn.onclick = async () => {
      const profile = await getUserProfile(user.uid);
      const activeAccount = profile.activeAccount || "Principal";
      const clickValue = profile.clickValue || 1;
      const boost = profile.boost || { doubleMoneyUntil: 0 };
      const gain = Date.now() < (boost.doubleMoneyUntil || 0) ? clickValue * 2 : clickValue;

      profile.accounts[activeAccount] = (profile.accounts[activeAccount] || 0) + gain;

      await updateUserProfile(user.uid, { accounts: profile.accounts });
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
        alert("Bonus déjà récupéré.");
        return;
      }

      profile.accounts[activeAccount] = (profile.accounts[activeAccount] || 0) + 250;
      const newHistory = profile.history || [];
      newHistory.unshift("Bonus journalier +250.00 €");

      await updateUserProfile(user.uid, {
        accounts: profile.accounts,
        lastDailyBonus: now,
        history: newHistory
      });

      await renderHome(user.uid);
    };
  }

  if (upgradeBtn) {
    upgradeBtn.onclick = async () => {
      const profile = await getUserProfile(user.uid);
      const activeAccount = profile.activeAccount || "Principal";
      const currentBalance = profile.accounts?.[activeAccount] || 0;
      const currentLevel = profile.clickLevel || 1;
      const nextUpgrade = getNextUpgrade(currentLevel);

      if (!nextUpgrade) return alert("Niveau maximal atteint.");
      if (currentBalance < nextUpgrade.cost) {
        return alert(`Pas assez d'argent. Il faut ${nextUpgrade.cost} €.`);
      }

      profile.accounts[activeAccount] = currentBalance - nextUpgrade.cost;
      profile.clickValue = nextUpgrade.value;
      profile.clickLevel = nextUpgrade.nextLevel;

      const newHistory = profile.history || [];
      newHistory.unshift(`Amélioration du clic -${nextUpgrade.cost.toFixed(2)} € → ${nextUpgrade.value} €/clic`);

      await updateUserProfile(user.uid, {
        accounts: profile.accounts,
        clickValue: profile.clickValue,
        clickLevel: profile.clickLevel,
        history: newHistory
      });

      await renderHome(user.uid);
    };
  }

  if (boostBtn) {
    boostBtn.onclick = async () => {
      const profile = await getUserProfile(user.uid);
      const activeAccount = profile.activeAccount || "Principal";
      const currentBalance = profile.accounts?.[activeAccount] || 0;
      const now = Date.now();
      const boostPrice = 1000;
      const durationMs = 60 * 1000;
      const boost = profile.boost || { doubleMoneyUntil: 0 };

      if (now < (boost.doubleMoneyUntil || 0)) {
        return alert("Le boost x2 est déjà actif.");
      }
      if (currentBalance < boostPrice) {
        return alert(`Pas assez d'argent. Il faut ${boostPrice} €.`);
      }

      profile.accounts[activeAccount] = currentBalance - boostPrice;
      profile.boost = { doubleMoneyUntil: now + durationMs };

      const newHistory = profile.history || [];
      newHistory.unshift(`Boost x2 acheté -${boostPrice.toFixed(2)} € (1 min)`);

      await updateUserProfile(user.uid, {
        accounts: profile.accounts,
        boost: profile.boost,
        history: newHistory
      });

      await renderHome(user.uid);
    };
  }

  if (loan500Btn) loan500Btn.onclick = async () => await takeLoanFirebase(user.uid, 500);
  if (loan2000Btn) loan2000Btn.onclick = async () => await takeLoanFirebase(user.uid, 2000);
  if (loan10000Btn) loan10000Btn.onclick = async () => await takeLoanFirebase(user.uid, 10000);
  if (repayAllBtn) repayAllBtn.onclick = async () => await repayAllLoansFirebase(user.uid);

  if (adminAddMoneyBtn) {
    adminAddMoneyBtn.onclick = async () => {
      const profile = await getUserProfile(user.uid);
      if (!profile.isAdmin) return;

      const activeAccount = profile.activeAccount || "Principal";
      const amount = Number(prompt("Montant à ajouter au compte actif ?"));
      if (!amount || amount <= 0) return alert("Montant invalide.");

      profile.accounts[activeAccount] = (profile.accounts[activeAccount] || 0) + amount;
      const newHistory = profile.history || [];
      newHistory.unshift(`Ajout admin +${amount.toFixed(2)} €`);

      await updateUserProfile(user.uid, {
        accounts: profile.accounts,
        history: newHistory
      });

      await renderHome(user.uid);
    };
  }

  setInterval(async () => {
    await autoLoanPaymentFirebase(user.uid);
    await renderHome(user.uid);
  }, 1000);
}

/* ================= PAYMENTS ================= */

async function renderPayments(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

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

      if (!beneficiaryName && !beneficiaryIban) return alert("Entre un bénéficiaire ou un IBAN.");
      if (!amount || amount <= 0) return alert("Entre un montant valide.");

      const activeAccount = sender.activeAccount || "Principal";
      const senderBalance = sender.accounts?.[activeAccount] || 0;
      if (senderBalance < amount) return alert("Pas assez d'argent.");

      const allUsers = await getAllUsers();
      const target = allUsers.find(u =>
        (beneficiaryIban && u.iban === beneficiaryIban) ||
        (beneficiaryName && ((u.displayName || "").toLowerCase() === beneficiaryName.toLowerCase() || (u.username || "").toLowerCase() === beneficiaryName.toLowerCase()))
      );

      if (!target) return alert("Aucun compte Rafael Bank trouvé.");
      if (target.uid === user.uid) return alert("Tu ne peux pas t'envoyer de virement à toi-même.");

      const receiver = await getUserProfile(target.uid);
      const receiverActiveAccount = receiver.activeAccount || "Principal";

      sender.accounts[activeAccount] = senderBalance - amount;
      sender.history = sender.history || [];
      sender.history.unshift(`Virement envoyé à ${target.displayName || target.username} -${amount.toFixed(2)} €`);

      receiver.accounts = receiver.accounts || {};
      receiver.accounts[receiverActiveAccount] = (receiver.accounts[receiverActiveAccount] || 0) + amount;
      receiver.history = receiver.history || [];
      receiver.history.unshift(`Virement reçu de ${sender.displayName || sender.username} +${amount.toFixed(2)} €`);

      await updateUserProfile(user.uid, {
        accounts: sender.accounts,
        history: sender.history
      });

      await updateUserProfile(target.uid, {
        accounts: receiver.accounts,
        history: receiver.history
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

      if (!targetValue) return alert("Entre un joueur.");
      if (!amount || amount <= 0) return alert("Entre un montant valide.");

      const allUsers = await getAllUsers();
      const target = allUsers.find(u =>
        (u.username || "").toLowerCase() === targetValue.toLowerCase() ||
        (u.displayName || "").toLowerCase() === targetValue.toLowerCase() ||
        (u.iban || "").toLowerCase() === targetValue.toLowerCase()
      );

      if (!target) return alert("Joueur introuvable.");
      if (target.uid === user.uid) return alert("Impossible d'envoyer à toi-même ici.");

      const targetProfile = await getUserProfile(target.uid);
      const targetActiveAccount = targetProfile.activeAccount || "Principal";

      targetProfile.accounts = targetProfile.accounts || {};
      targetProfile.accounts[targetActiveAccount] = (targetProfile.accounts[targetActiveAccount] || 0) + amount;
      targetProfile.history = targetProfile.history || [];
      targetProfile.history.unshift(`Cadeau admin +${amount.toFixed(2)} €`);

      adminProfile.history = adminProfile.history || [];
      adminProfile.history.unshift(`Envoi admin vers ${target.displayName || target.username} -${amount.toFixed(2)} €`);

      await updateUserProfile(target.uid, {
        accounts: targetProfile.accounts,
        history: targetProfile.history
      });

      await updateUserProfile(user.uid, {
        history: adminProfile.history
      });

      const adminTargetUserInput = document.getElementById("adminTargetUser");
      const adminAmountInput = document.getElementById("adminAmount");
      if (adminTargetUserInput) adminTargetUserInput.value = "";
      if (adminAmountInput) adminAmountInput.value = "";

      await renderPayments(user.uid);
      alert("Argent envoyé.");
    };
  }

  setInterval(async () => {
    await renderPayments(user.uid);
  }, 1000);
}

/* ================= CARDS ================= */

async function renderCards(uid) {
  const profile = await getUserProfile(uid);
  if (!profile) return;

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
        return alert("Le PIN doit contenir exactement 4 chiffres.");
      }

      profile.card = profile.card || {};
      profile.card.pin = newCardPin;
      profile.card.revealed = false;
      profile.card.blocked = profile.card.blocked || false;
      profile.card.type = profile.card.type || "classic";

      await updateUserProfile(user.uid, { card: profile.card });
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
        return alert("PIN incorrect.");
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
    BTC: { price: 30000, history: [30000, 30120, 30050] },
    ETH: { price: 2000, history: [2000, 2015, 1998] },
    AAPL: { price: 180, history: [180, 181, 179] },
    TSLA: { price: 250, history: [250, 248, 252] },
    NVDA: { price: 500, history: [500, 506, 503] },
    RCOP: { price: 5000, history: [5000, 5035, 4990] }
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

  await updateUserProfile(uid, { crypto: profile.crypto });
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
  if (!amount || amount <= 0) return alert("Entre un montant valide.");

  const activeAccount = profile.activeAccount || "Principal";
  const balance = profile.accounts?.[activeAccount] || 0;
  if (balance < amount) return alert("Pas assez d'argent.");

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

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    history: profile.history,
    crypto: profile.crypto
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
  if (!qty || qty <= 0) return alert("Quantité invalide.");

  const activeAccount = profile.activeAccount || "Principal";
  const assetKey = profile.crypto.currentAsset;
  const asset = profile.crypto.assets[assetKey];
  if (!asset) return;
  if (qty > (asset.owned || 0)) return alert("Pas assez d’unités.");

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

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    history: profile.history,
    crypto: profile.crypto
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
  if (!asset || (asset.owned || 0) <= 0) return alert("Rien à vendre.");

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

  await updateUserProfile(uid, {
    accounts: profile.accounts,
    history: profile.history,
    crypto: profile.crypto
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
  bindLogout();
  await renderCrypto(user.uid);

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
      await updateUserProfile(user.uid, { crypto: profile.crypto });
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
      await updateUserProfile(user.uid, { crypto: profile.crypto });
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
      if (!newPrice || newPrice <= 0) return alert("Prix invalide.");

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
      await updateUserProfile(user.uid, { history: profile.history });

      await renderCrypto(user.uid);
    };
  }

  setInterval(async () => {
    await tickGlobalCryptoMarket(user.uid);
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
        </div>

        <div id="${historyId}" class="history-popup" style="display:none; margin-top:12px;">
          <div class="list-item">
            ${
              u.history && u.history.length
                ? u.history.map(item => `<div style="margin-bottom:6px;">${escapeHtml(item)}</div>`).join("")
                : "Aucun historique."
            }
          </div>
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
      </div>
    `;
  }).join("");
}

async function initAdmin(user) {
  bindLogout();
  await renderAdmin(user);
}

/* ================= BOOT ================= */

watchAuth(async (user) => {
  if (!user) {
    window.location.href = "login.html";
    return;
  }

  if (page === "home") await initHome(user);
  if (page === "payments") await initPayments(user);
  if (page === "cards") await initCards(user);
  if (page === "crypto") await initCrypto(user);
  if (page === "admin") await initAdmin(user);
});