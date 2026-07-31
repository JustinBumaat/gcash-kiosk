let currentInput = "";
let currentAmount = 0;
let currentProcessingFee = 0;
let selectedFeeMode = "";

let cashInPhone = "";
let cashInAmountInput = "";
let cashInAmount = 0;
let cashInProcessingFee = 0;
let receiptPollTimer = null;
let lastReceiptTimestamp = 0;
let cashInNotificationSent = false;

let timeoutTimer = null;
let qrCountdown = null;
let toastTimer = null;
let idleSlideTimer = null;
let idleSlideResetTimer = null;
let idleSlideIndex = 0;
let wifiQrPopupTimer = null;
let wifiQrCountdownTimer = null;

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const IDLE_SLIDE_INTERVAL_MS = 5000;
const IDLE_SLIDE_TRANSITION_MS = 650;
const QR_EXPIRY_SECONDS = 300;
const WIFI_QR_POPUP_SECONDS = 60;
const MAX_INPUT_DIGITS = 8;
const MAX_AMOUNT = 10000;

const processingFeeTable = [
    [1, 300, 5],
    [301, 700, 10],
    [701, 1000, 15],
    [1001, 1500, 25],
    [1501, 2000, 30],
    [2001, 3000, 45],
    [3001, 3500, 55],
    [3501, 4000, 60],
    [4001, 4500, 70],
    [4501, 5000, 75],
    [5001, 5500, 85],
    [5501, 6000, 90],
    [6001, 6500, 100],
    [6501, 7000, 105],
    [7001, 7500, 115],
    [7501, 8000, 120],
    [8001, 8500, 130],
    [8501, 9000, 135],
    [9001, 9500, 145],
    [9501, 10000, 150],
];

function money(value) {
    return Number(value).toLocaleString("en-PH", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

function getProcessingFee(amount) {
    if (amount <= 0) return 0;
    for (const [min, max, fee] of processingFeeTable) {
        if (amount >= min && amount <= max) return fee;
    }
    return null;
}

function formatPhone(value) {
    const padded = (value || "").padEnd(11, "_");
    return `${padded.slice(0, 4)} ${padded.slice(4, 7)} ${padded.slice(7, 11)}`;
}

function clearReceiptPolling() {
    clearInterval(receiptPollTimer);
    receiptPollTimer = null;
}

function armIdleTimeout() {
    clearTimeout(timeoutTimer);

    const activeScreen = document.querySelector(".screen.active");
    if (!activeScreen || activeScreen.id === "screen-idle") return;

    timeoutTimer = setTimeout(() => {
        showIdleScreen();
    }, IDLE_TIMEOUT_MS);
}

function setIdleSlidePosition(animate = true) {
    const track = document.querySelector(".idle-slide-track");
    if (!track) return;
    track.style.transition = animate ? `transform ${IDLE_SLIDE_TRANSITION_MS}ms ease-in-out` : "none";
    track.style.transform = `translate3d(-${idleSlideIndex * 100}%, 0, 0)`;
}

function stopIdleSlideshow() {
    clearInterval(idleSlideTimer);
    clearTimeout(idleSlideResetTimer);
    idleSlideTimer = null;
    idleSlideResetTimer = null;
    idleSlideIndex = 0;
    setIdleSlidePosition(false);
}

function startIdleSlideshow() {
    stopIdleSlideshow();
    const slides = document.querySelectorAll(".idle-slide");
    const realSlideCount = Math.max(0, slides.length - 1);
    if (realSlideCount < 2) return;

    requestAnimationFrame(() => setIdleSlidePosition(true));
    idleSlideTimer = setInterval(() => {
        idleSlideIndex += 1;
        setIdleSlidePosition(true);

        if (idleSlideIndex === realSlideCount) {
            const track = document.querySelector(".idle-slide-track");
            let loopResetComplete = false;
            const resetLoop = () => {
                if (loopResetComplete || !track) return;
                loopResetComplete = true;
                clearTimeout(idleSlideResetTimer);
                track.removeEventListener("transitionend", resetLoop);

                const idleScreen = document.getElementById("screen-idle");
                if (!idleScreen?.classList.contains("active")) return;
                idleSlideIndex = 0;
                setIdleSlidePosition(false);
                // Force the non-animated reset to commit before the next forward slide.
                void track.offsetWidth;
                track.style.transition = `transform ${IDLE_SLIDE_TRANSITION_MS}ms ease-in-out`;
            };

            track?.addEventListener("transitionend", resetLoop);
            idleSlideResetTimer = setTimeout(resetLoop, IDLE_SLIDE_TRANSITION_MS + 100);
        }
    }, IDLE_SLIDE_INTERVAL_MS);
}

function showIdleScreen() {
    clearTimeout(timeoutTimer);
    clearInterval(qrCountdown);
    clearReceiptPolling();
    resetAll();

    document.querySelectorAll(".screen").forEach((screen) => {
        screen.classList.remove("active");
    });

    const idleScreen = document.getElementById("screen-idle");
    idleScreen.classList.add("active");
    startIdleSlideshow();
    idleScreen.focus({ preventScroll: true });
}

function exitIdleScreen() {
    if (!document.getElementById("screen-idle")?.classList.contains("active")) return;
    navTo("home");
}

function navTo(screenId) {
    clearTimeout(timeoutTimer);
    clearInterval(qrCountdown);
    clearReceiptPolling();
    stopIdleSlideshow();
    closeWifiQr();

    document.querySelectorAll(".screen").forEach((screen) => {
        screen.classList.remove("active");
    });

    if (screenId === "home") {
        resetAll();
    }

    const target = document.getElementById(`screen-${screenId}`);
    if (!target) return;
    target.classList.add("active");
    target.scrollTop = 0;

    if (screenId === "cashin-receipt") {
        startReceiptPolling();
    }

    armIdleTimeout();
}

function resetAll() {
    resetCashOut();
    resetCashIn();
}

function resetCashOut() {
    currentInput = "";
    currentAmount = 0;
    currentProcessingFee = 0;
    selectedFeeMode = "";
    const btnGen = document.getElementById("btn-generate");
    if (btnGen) btnGen.disabled = true;
    const note = document.getElementById("qr-fee-note");
    if (note) note.hidden = true;
    imageReset();
    updateFeeModeCards();
    updateDisplay();
}

function resetCashIn() {
    cashInPhone = "";
    cashInAmountInput = "";
    cashInAmount = 0;
    cashInProcessingFee = 0;
    lastReceiptTimestamp = 0;
    cashInNotificationSent = false;
    renderReceiptWaiting();
    updateCashInPhoneDisplay();
    updateCashInAmountDisplay();
}

function imageReset() {
    const image = document.getElementById("qr-image");
    const loader = document.getElementById("qr-loader");
    if (image) {
        image.hidden = true;
        image.removeAttribute("src");
    }
    if (loader) loader.hidden = false;
    const ref = document.getElementById("ref-number");
    if (ref) ref.textContent = "---";
}

function press(key) {
    if (key === "C") {
        currentInput = "";
    } else if (key === "BACKSPACE") {
        currentInput = currentInput.slice(0, -1);
    } else if (currentInput.length < MAX_INPUT_DIGITS) {
        currentInput += key;
    }
    currentInput = currentInput.replace(/^0+(?=\d)/, "");
    updateDisplay();
}

function updateDisplay() {
    const rawAmount = Number.parseInt(currentInput || "0", 10);
    currentAmount = rawAmount / 100;
    currentProcessingFee = getProcessingFee(currentAmount) ?? 0;

    document.getElementById("amount-display").textContent = money(currentAmount);
    document.getElementById("amount-processing-fee").textContent = `₱${money(currentProcessingFee)}`;

    const helper = document.getElementById("amount-helper");
    const nextButton = document.getElementById("btn-next");
    const isValid = currentAmount > 0 && currentAmount <= MAX_AMOUNT && getProcessingFee(currentAmount) !== null;
    nextButton.disabled = !isValid;

    if (currentAmount === 0) {
        helper.textContent = "Type the amount using cents. Example: 1234 becomes ₱12.34.";
    } else if (!isValid) {
        helper.textContent = "The supported amount range is ₱1.00 to ₱10,000.00.";
    } else {
        helper.textContent = "The last two digits are centavos. You will choose how to pay the processing fee in the next step.";
    }
}

function prepareReview() {
    const fee = getProcessingFee(currentAmount);
    if (!(currentAmount > 0) || fee === null) {
        showToast("The supported amount range is ₱1.00 to ₱10,000.00.");
        return;
    }
    currentProcessingFee = fee;
    selectedFeeMode = "";
    document.getElementById("rev-amount").textContent = `₱${money(currentAmount)}`;
    document.getElementById("rev-processing-fee").textContent = `₱${money(currentProcessingFee)}`;
    document.getElementById("rev-total").textContent = `₱${money(currentAmount)}`;
    document.getElementById("btn-generate").disabled = true;
    updateFeeModeCards();
    navTo("review");
}

function selectFeeMode(mode) {
    selectedFeeMode = mode;
    const qrTotal = mode === "include" ? currentAmount + currentProcessingFee : currentAmount;
    document.getElementById("rev-total").textContent = `₱${money(qrTotal)}`;
    document.getElementById("btn-generate").disabled = false;
    updateFeeModeCards();
}

function updateFeeModeCards() {
    const includeCard = document.getElementById("fee-option-include");
    const counterCard = document.getElementById("fee-option-counter");
    if (!includeCard || !counterCard) return;
    includeCard.classList.toggle("selected", selectedFeeMode === "include");
    counterCard.classList.toggle("selected", selectedFeeMode === "counter");
    includeCard.setAttribute("aria-pressed", selectedFeeMode === "include" ? "true" : "false");
    counterCard.setAttribute("aria-pressed", selectedFeeMode === "counter" ? "true" : "false");
}

async function generateQR() {
    if (currentAmount <= 0 || !selectedFeeMode) return;
    navTo("qr");

    const qrAmount = selectedFeeMode === "include" ? currentAmount + currentProcessingFee : currentAmount;
    document.getElementById("qr-amount-display").textContent = `₱${money(qrAmount)}`;
    document.getElementById("qr-base-amount").textContent = `₱${money(currentAmount)}`;
    document.getElementById("qr-processing-fee").textContent = `₱${money(currentProcessingFee)}`;
    document.getElementById("qr-fee-mode").textContent = selectedFeeMode === "include" ? "Included in QR" : "Pay at counter";
    document.getElementById("payment-status").textContent = "Generating QR code";
    document.getElementById("time-left").textContent = "05:00";

    const noteBox = document.getElementById("qr-fee-note");
    const noteText = document.getElementById("qr-fee-note-text");
    if (selectedFeeMode === "counter") {
        noteText.textContent = `Please pay the ₱${money(currentProcessingFee)} processing fee at the cashier.`;
        noteBox.hidden = false;
    } else {
        noteBox.hidden = true;
    }

    imageReset();
    try {
        const response = await fetch("/api/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ amount: qrAmount }),
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || "QR generation failed");

        const loader = document.getElementById("qr-loader");
        const image = document.getElementById("qr-image");
        image.src = data.qr_image;
        image.hidden = false;
        loader.hidden = true;
        document.getElementById("ref-number").textContent = data.reference;
        document.getElementById("payment-status").textContent = "Waiting for payment";
        startCountdown();
    } catch (error) {
        console.error(error);
        showToast("The QR code could not be generated. Please try again.");
        setTimeout(() => navTo("review"), 900);
    }
}

function startCountdown() {
    clearInterval(qrCountdown);
    let time = QR_EXPIRY_SECONDS;
    const display = document.getElementById("time-left");
    const render = () => {
        display.textContent = `${String(Math.floor(time / 60)).padStart(2, "0")}:${String(time % 60).padStart(2, "0")}`;
    };
    render();
    qrCountdown = setInterval(() => {
        time -= 1;
        render();
        if (time <= 0) {
            clearInterval(qrCountdown);
            showToast("This QR code has expired.");
            setTimeout(() => navTo("home"), 900);
        }
    }, 1000);
}

function cancelTransaction() {
    clearInterval(qrCountdown);
    navTo("home");
}

function formatTimeLeft(seconds) {
    const safeSeconds = Math.max(0, Math.ceil(seconds));
    return `${String(Math.floor(safeSeconds / 60)).padStart(2, "0")}:${String(safeSeconds % 60).padStart(2, "0")}`;
}

function closeWifiQr() {
    clearTimeout(wifiQrPopupTimer);
    clearInterval(wifiQrCountdownTimer);
    wifiQrPopupTimer = null;
    wifiQrCountdownTimer = null;
    const modal = document.getElementById("wifi-qr-modal");
    if (modal) modal.hidden = true;
}

function startWifiQrCountdown(expiresAt) {
    clearInterval(wifiQrCountdownTimer);
    const display = document.getElementById("wifi-qr-time-left");
    const render = () => {
        const secondsLeft = Number(expiresAt) - (Date.now() / 1000);
        if (display) display.textContent = formatTimeLeft(secondsLeft);
        if (secondsLeft <= 0) {
            closeWifiQr();
            showToast("Guest WiFi access has ended.");
        }
    };
    render();
    wifiQrCountdownTimer = setInterval(render, 1000);
}

async function openWifiQr() {
    const button = document.getElementById("btn-wifi-qr");
    if (button?.disabled) return;
    if (button) {
        button.disabled = true;
        button.textContent = "Opening WiFi…";
    }

    try {
        const response = await fetch("/api/wifi-hotspot", { method: "POST" });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || "WiFi QR could not be opened.");

        document.getElementById("wifi-qr-image").src = data.qr_image;
        document.getElementById("wifi-qr-ssid").textContent = data.ssid;
        document.getElementById("wifi-qr-password").textContent = data.password;
        const modal = document.getElementById("wifi-qr-modal");
        modal.hidden = false;
        startWifiQrCountdown(data.expires_at);
        clearTimeout(wifiQrPopupTimer);
        wifiQrPopupTimer = setTimeout(closeWifiQr, WIFI_QR_POPUP_SECONDS * 1000);
    } catch (error) {
        console.error(error);
        showToast(error.message || "The guest WiFi could not be started.");
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = "WiFi QR";
        }
    }
}

function pressCashInPhone(key) {
    if (key === "C") {
        cashInPhone = "";
    } else if (key === "BACKSPACE") {
        cashInPhone = cashInPhone.slice(0, -1);
    } else if (cashInPhone.length < 11) {
        cashInPhone += key;
    }
    updateCashInPhoneDisplay();
}

function updateCashInPhoneDisplay() {
    const display = document.getElementById("cashin-phone-display");
    const cells = display ? [...display.querySelectorAll(".phone-cell")] : [];
    const nextIndex = cashInPhone.length < 11 ? cashInPhone.length : -1;

    cells.forEach((cell, index) => {
        const digit = cashInPhone[index] || "";
        cell.textContent = digit;
        cell.classList.toggle("filled", Boolean(digit));
        cell.classList.toggle("next", index === nextIndex);
    });

    document.getElementById("btn-cashin-number-next").disabled = cashInPhone.length !== 11;
}

function goToCashInAmount() {
    if (cashInPhone.length !== 11) return;
    navTo("cashin-amount");
}

function pressCashInAmount(key) {
    if (key === "C") {
        cashInAmountInput = "";
    } else if (key === "BACKSPACE") {
        cashInAmountInput = cashInAmountInput.slice(0, -1);
    } else if (cashInAmountInput.length < MAX_INPUT_DIGITS) {
        cashInAmountInput += key;
    }
    cashInAmountInput = cashInAmountInput.replace(/^0+(?=\d)/, "");
    updateCashInAmountDisplay();
}

function updateCashInAmountDisplay() {
    const rawAmount = Number.parseInt(cashInAmountInput || "0", 10);
    cashInAmount = rawAmount / 100;
    cashInProcessingFee = getProcessingFee(cashInAmount) ?? 0;

    document.getElementById("cashin-amount-display").textContent = money(cashInAmount);
    document.getElementById("cashin-processing-fee").textContent = `₱${money(cashInProcessingFee)}`;

    const helper = document.getElementById("cashin-amount-helper");
    const nextButton = document.getElementById("btn-cashin-amount-next");
    const isValid = cashInAmount > 0 && cashInAmount <= MAX_AMOUNT && getProcessingFee(cashInAmount) !== null;
    nextButton.disabled = !isValid;

    if (cashInAmount === 0) {
        helper.textContent = "Type the amount using cents. Example: 1234 becomes ₱12.34.";
    } else if (!isValid) {
        helper.textContent = "The supported amount range is ₱1.00 to ₱10,000.00.";
    } else {
        helper.textContent = "The processing fee updates automatically based on the amount.";
    }
}

async function prepareCashInReceiptScreen(refreshOnly = false) {
    const fee = getProcessingFee(cashInAmount);
    if (!refreshOnly && (!(cashInAmount > 0) || fee === null)) {
        showToast("The supported amount range is ₱1.00 to ₱10,000.00.");
        return;
    }

    cashInProcessingFee = fee ?? cashInProcessingFee;
    const total = cashInAmount + cashInProcessingFee;
    document.getElementById("cashin-review-phone").textContent = formatPhone(cashInPhone);
    document.getElementById("cashin-review-amount").textContent = `₱${money(cashInAmount)}`;
    document.getElementById("cashin-review-fee").textContent = `₱${money(cashInProcessingFee)}`;
    document.getElementById("cashin-review-total").textContent = `₱${money(total)}`;
    document.getElementById("cashin-counter-note").textContent = `Please pay ₱${money(total)} at the counter.`;

    if (!refreshOnly) {
        try {
            await fetch("/api/receipt/clear", { method: "POST" });
        } catch (error) {
            console.error(error);
        }

        renderReceiptWaiting();
        navTo("cashin-receipt");

        if (!cashInNotificationSent) {
            cashInNotificationSent = true;
            sendCashInNotification(total);
        }
    } else {
        fetchLatestReceipt();
    }
}

async function sendCashInNotification(total) {
    try {
        const response = await fetch("/api/cashin-notify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                phone: cashInPhone,
                amount: cashInAmount,
                fee: cashInProcessingFee,
                total,
            }),
        });

        const data = await response.json();
        if (!response.ok || !data.success) {
            console.warn(data.message || data.error || "Telegram message was not sent.");
            return;
        }

        showToast("Transaction details sent to Teller.");
    } catch (error) {
        console.error("Telegram notification error:", error);
    }
}

function renderReceiptWaiting() {
    const screen = document.getElementById("screen-cashin-receipt");
    const img = document.getElementById("receipt-image");
    const empty = document.getElementById("receipt-empty");
    const meta = document.getElementById("receipt-meta");
    screen.classList.remove("receipt-ready");
    document.getElementById("receipt-status").textContent = "Waiting for receipt…";
    empty.hidden = false;
    img.hidden = true;
    img.removeAttribute("src");
    meta.hidden = true;
    document.getElementById("receipt-meta-phone").textContent = "";
    document.getElementById("receipt-meta-amount").textContent = "";
    document.getElementById("receipt-meta-note").textContent = "";
}

function renderReceiptData(data) {
    const img = document.getElementById("receipt-image");
    const empty = document.getElementById("receipt-empty");
    const meta = document.getElementById("receipt-meta");
    if (!data.available) {
        renderReceiptWaiting();
        return;
    }

    document.getElementById("screen-cashin-receipt").classList.add("receipt-ready");
    document.getElementById("receipt-status").textContent = "Receipt received";
    empty.hidden = true;
    img.src = data.image_url + `?t=${data.uploaded_at}`;
    img.hidden = false;
    meta.hidden = false;
    document.getElementById("receipt-meta-phone").textContent = data.phone ? `Phone: ${data.phone}` : "";
    document.getElementById("receipt-meta-amount").textContent = data.amount ? `Amount: ${data.amount}` : "";
    document.getElementById("receipt-meta-note").textContent = data.note ? `Note: ${data.note}` : "";
}

async function fetchLatestReceipt() {
    try {
        const response = await fetch("/api/receipt/latest");
        const data = await response.json();
        if (data.available && data.uploaded_at !== lastReceiptTimestamp) {
            lastReceiptTimestamp = data.uploaded_at;
        }
        renderReceiptData(data);
    } catch (error) {
        console.error(error);
    }
}

function startReceiptPolling() {
    fetchLatestReceipt();
    clearReceiptPolling();
    receiptPollTimer = setInterval(fetchLatestReceipt, 2500);
}

function showToast(message) {
    const toast = document.getElementById("toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

window.addEventListener("keydown", (event) => {
    armIdleTimeout();
    const activeScreen = document.querySelector(".screen.active")?.id;

    if (activeScreen === "screen-idle") {
        if (["Enter", " ", "Escape"].includes(event.key)) {
            event.preventDefault();
            exitIdleScreen();
        }
        return;
    }

    if (activeScreen === "screen-cashout-amount") {
        if (/^\d$/.test(event.key)) press(event.key);
        if (event.key === "Backspace") press("BACKSPACE");
        if (event.key === "Escape") press("C");
        if (event.key === "Enter" && !document.getElementById("btn-next").disabled) prepareReview();
    }

    if (activeScreen === "screen-cashin-number") {
        if (/^\d$/.test(event.key)) pressCashInPhone(event.key);
        if (event.key === "Backspace") pressCashInPhone("BACKSPACE");
        if (event.key === "Escape") pressCashInPhone("C");
        if (event.key === "Enter" && !document.getElementById("btn-cashin-number-next").disabled) goToCashInAmount();
    }

    if (activeScreen === "screen-cashin-amount") {
        if (/^\d$/.test(event.key)) pressCashInAmount(event.key);
        if (event.key === "Backspace") pressCashInAmount("BACKSPACE");
        if (event.key === "Escape") pressCashInAmount("C");
        if (event.key === "Enter" && !document.getElementById("btn-cashin-amount-next").disabled) prepareCashInReceiptScreen();
    }
});

// Touching or clicking any active transaction screen restarts the 10-minute idle timer.
window.addEventListener("pointerdown", armIdleTimeout, { passive: true });

showIdleScreen();
