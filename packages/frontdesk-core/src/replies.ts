/**
 * Every sentence the assistant says. Numbers, names, rates and times arrive here from MedOS records and are slotted in; the language
 * model never writes any of them. Hindi uses Devanagari with Latin digits so a screen reader and a text-to-speech voice say amounts
 * and times unambiguously.
 */
export type Lang = "hi" | "en";
const L = (lang: Lang, hi: string, en: string) => (lang === "hi" ? hi : en);

const WD_HI = ["रविवार", "सोमवार", "मंगलवार", "बुधवार", "गुरुवार", "शुक्रवार", "शनिवार"];
const WD_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_HI = ["जनवरी", "फ़रवरी", "मार्च", "अप्रैल", "मई", "जून", "जुलाई", "अगस्त", "सितंबर", "अक्टूबर", "नवंबर", "दिसंबर"];
const MONTH_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const dayNumber = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);

/** "कल (गुरुवार, 5 नवंबर)" / "tomorrow (Thursday, 5 November)". */
export function dateWords(iso: string, todayIso: string, lang: Lang): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const diff = dayNumber(iso) - dayNumber(todayIso);
  const plain = L(lang, `${WD_HI[wd]}, ${d} ${MONTH_HI[m - 1]}`, `${WD_EN[wd]}, ${d} ${MONTH_EN[m - 1]}`);
  if (diff === 0) return L(lang, `आज (${plain})`, `today (${plain})`);
  if (diff === 1) return L(lang, `कल (${plain})`, `tomorrow (${plain})`);
  return plain;
}

/** "सुबह 10:10 बजे" / "10:10 AM". */
export function timeWords(hhmm: string, lang: Lang): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const mm = String(m).padStart(2, "0");
  if (lang === "en") return `${h12}:${mm} ${h < 12 ? "AM" : "PM"}`;
  const part = h < 4 ? "रात" : h < 12 ? "सुबह" : h < 16 ? "दोपहर" : h < 20 ? "शाम" : "रात";
  return `${part} ${h12}:${mm} बजे`;
}

export const rupees = (amount: string): string => `₹${amount.replace(/\.00$/, "")}`;
const list = (items: string[], lang: Lang) => items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${L(lang, "और", "and")} ${items[items.length - 1]}`;

export interface LabLine { name: string; price: string; reportHours: number; fastingRequired: boolean; prep: string | null }

export const T = {
  greet: (lang: Lang) => L(lang, "नमस्ते! मैं जांच का शुल्क बता सकता हूँ, डॉक्टर की अपॉइंटमेंट और लैब टेस्ट बुक कर सकता हूँ। बताइए, क्या चाहिए?", "Hello! I can tell you lab test rates and book doctor appointments and lab tests. What do you need?"),
  didNotUnderstand: (lang: Lang) => L(lang, "माफ़ कीजिए, मैं समझ नहीं पाया। आप जांच का शुल्क पूछ सकते हैं, या डॉक्टर / लैब टेस्ट बुक करवा सकते हैं।", "Sorry, I did not understand. You can ask for a test rate, or book a doctor or a lab test."),
  cancelled: (lang: Lang) => L(lang, "ठीक है, रद्द कर दिया। और कुछ चाहिए?", "Okay, cancelled. Anything else?"),
  noPermission: (lang: Lang) => L(lang, "माफ़ कीजिए, इस काम की अनुमति आपके खाते में नहीं है।", "Sorry, your account does not have permission for this."),
  problem: (lang: Lang) => L(lang, "माफ़ कीजिए, अभी कुछ गड़बड़ हो गई। कृपया दोबारा कोशिश करें।", "Sorry, something went wrong. Please try again."),
  emergency: (lang: Lang) => L(lang, "यह आपातकालीन स्थिति हो सकती है। कृपया अभी नज़दीकी अस्पताल के इमरजेंसी विभाग में जाएँ या एम्बुलेंस बुलाएँ। मैं इसके लिए अपॉइंटमेंट नहीं लगाऊँगा।", "This may be an emergency. Please go to the nearest emergency department now or call an ambulance. I will not book an appointment for this."),

  askTests: (lang: Lang) => L(lang, "कौन सी जांच करवानी है? नाम बताइए।", "Which test do you need? Please tell me the name."),
  testsNotFound: (lang: Lang) => L(lang, "मुझे यह जांच हमारी सूची में नहीं मिली। कृपया नाम दोबारा बताइए, जैसे CBC, थायराइड, शुगर या लिपिड प्रोफाइल।", "I could not find that test in our list. Please say the name again, for example CBC, thyroid, sugar or lipid profile."),
  askTestChoice: (options: string[], lang: Lang) => L(lang, `इनमें से कौन सी जांच चाहिए: ${options.join(" या ")}?`, `Which of these do you mean: ${options.join(" or ")}?`),
  labRates: (lines: LabLine[], total: string, lang: Lang) => {
    const parts = lines.map((l) => L(lang, `${l.name}: ${rupees(l.price)}, रिपोर्ट लगभग ${l.reportHours} घंटे में${l.fastingRequired ? ", खाली पेट आना होगा" : ""}`, `${l.name}: ${rupees(l.price)}, report in about ${l.reportHours} hours${l.fastingRequired ? ", fasting needed" : ""}`));
    const head = lines.length > 1 ? L(lang, `कुल ${rupees(total)}। `, `Total ${rupees(total)}. `) : "";
    return `${head}${parts.join(L(lang, "। ", ". "))}${L(lang, "। बुक करवाना चाहें तो बताइए।", ". Tell me if you want to book.")}`;
  },
  askDate: (lang: Lang) => L(lang, "कब आना चाहेंगे? जैसे 'कल सुबह' या 'सोमवार शाम'।", "When would you like to come? For example 'tomorrow morning' or 'Monday evening'."),
  askCollectionDate: (lang: Lang) => L(lang, "सैंपल कब देना चाहेंगे? जैसे 'कल सुबह'।", "When would you like to give the sample? For example 'tomorrow morning'."),
  askName: (lang: Lang) => L(lang, "मरीज़ का नाम क्या है?", "What is the patient's name?"),
  askAge: (name: string, lang: Lang) => L(lang, `${name} की उम्र कितनी है?`, `How old is ${name}?`),
  /** Added when the same question has to be asked again, so a caller who is not being understood is not stuck in a loop. */
  typeTip: (lang: Lang) => L(lang, "आवाज़ से समझने में दिक्कत हो रही है। कृपया इसका जवाब अंकों या शब्दों में टाइप करके भेजें।", "I am having trouble understanding the voice. Please type your answer and send it."),
  askMobile: (lang: Lang) => L(lang, "संपर्क के लिए 10 अंकों का मोबाइल नंबर बताइए।", "Please tell me a 10-digit mobile number."),
  badMobile: (lang: Lang) => L(lang, "यह मोबाइल नंबर सही नहीं लगा। कृपया 10 अंकों का नंबर दोबारा बताइए।", "That mobile number does not look right. Please say the 10 digits again."),

  noDoctor: (lang: Lang) => L(lang, "मुझे इस नाम या विभाग का डॉक्टर नहीं मिला। किस डॉक्टर या किस समस्या के लिए बुक करना है?", "I could not find a doctor for that name or department. Which doctor, or what is the problem?"),
  askDoctor: (lang: Lang) => L(lang, "किस डॉक्टर या किस समस्या के लिए अपॉइंटमेंट चाहिए?", "Which doctor, or what is the problem, is the appointment for?"),
  askDoctorChoice: (names: string[], lang: Lang) => L(lang, `इनमें से कौन से डॉक्टर: ${names.join(" या ")}?`, `Which of these doctors: ${names.join(" or ")}?`),
  noSlots: (doctor: string, lang: Lang) => L(lang, `${doctor} की अगले 2 हफ्तों में कोई खाली जगह नहीं मिली। किसी और डॉक्टर के लिए देखें?`, `${doctor} has no free time in the next 2 weeks. Shall I look at another doctor?`),
  slotTaken: (doctor: string, date: string, alternatives: string[], lang: Lang) => L(lang, `${doctor} का वह समय खाली नहीं है। ${date} को ये समय खाली हैं: ${alternatives.join(", ")}। कौन सा चाहिए?`, `That time is not free with ${doctor}. On ${date} these are free: ${alternatives.join(", ")}. Which one?`),
  noSlotThatDay: (doctor: string, date: string, next: string | null, lang: Lang) => L(lang, `${doctor} ${date} को उपलब्ध नहीं हैं।${next ? ` अगली उपलब्धता ${next} है। वह चलेगा?` : " कोई और दिन बताइए।"}`, `${doctor} is not available on ${date}.${next ? ` The next availability is ${next}. Would that do?` : " Please name another day."}`),
  department: (dept: string, lang: Lang) => L(lang, `ठीक है, ${dept} विभाग के लिए देखता हूँ।`, `Okay, I will look at the ${dept} department.`),
  offer: (doctor: string, dept: string, when: string, lang: Lang) => L(lang, `${dept} में ${doctor} का सबसे पहला समय ${when} है।`, `The earliest with ${doctor} (${dept}) is ${when}.`),

  confirmLab: (c: { name: string; age: number; mobile: string | null; tests: string[]; total: string; when: string; home: boolean }, lang: Lang) => L(
    lang,
    `पक्का कर लूँ? मरीज़ ${c.name}, उम्र ${c.age}${c.mobile ? `, मोबाइल ${c.mobile}` : ""}। जांच: ${list(c.tests, lang)}। कुल ${rupees(c.total)}। ${c.when} को ${c.home ? "घर पर सैंपल" : "लैब में सैंपल"}। बुक करूँ? हाँ या नहीं।`,
    `Shall I confirm? Patient ${c.name}, age ${c.age}${c.mobile ? `, mobile ${c.mobile}` : ""}. Tests: ${list(c.tests, lang)}. Total ${rupees(c.total)}. ${c.when}, ${c.home ? "home collection" : "at the lab"}. Book it? Yes or no.`,
  ),
  confirmDoctor: (c: { name: string; age: number; mobile: string | null; doctor: string; dept: string; when: string }, lang: Lang) => L(
    lang,
    `पक्का कर लूँ? मरीज़ ${c.name}, उम्र ${c.age}${c.mobile ? `, मोबाइल ${c.mobile}` : ""}। ${c.doctor} (${c.dept}), ${c.when}। बुक करूँ? हाँ या नहीं।`,
    `Shall I confirm? Patient ${c.name}, age ${c.age}${c.mobile ? `, mobile ${c.mobile}` : ""}. ${c.doctor} (${c.dept}), ${c.when}. Book it? Yes or no.`,
  ),
  bookedLab: (c: { ref: string; mrn: string | null; total: string; when: string; prep: string[] }, lang: Lang) => L(
    lang,
    `लैब बुकिंग हो गई। संदर्भ संख्या ${c.ref}${c.mrn ? `, रिकॉर्ड नंबर ${c.mrn}` : ""}। ${c.when}। कुल ${rupees(c.total)}।${c.prep.length ? ` ध्यान दें: ${c.prep.join(" ")}` : ""}`,
    `Lab booking done. Reference ${c.ref}${c.mrn ? `, record number ${c.mrn}` : ""}. ${c.when}. Total ${rupees(c.total)}.${c.prep.length ? ` Please note: ${c.prep.join(" ")}` : ""}`,
  ),
  bookedDoctor: (c: { ref: string; mrn: string | null; doctor: string; dept: string; when: string }, lang: Lang) => L(
    lang,
    `अपॉइंटमेंट बुक हो गई। संदर्भ संख्या ${c.ref}${c.mrn ? `, रिकॉर्ड नंबर ${c.mrn}` : ""}। ${c.doctor} (${c.dept}), ${c.when}।`,
    `Appointment booked. Reference ${c.ref}${c.mrn ? `, record number ${c.mrn}` : ""}. ${c.doctor} (${c.dept}), ${c.when}.`,
  ),
  needChange: (lang: Lang) => L(lang, "ठीक है, क्या बदलना है? समय, तारीख, या कुछ और?", "Okay, what should I change? The time, the day, or something else?"),
  nothingToConfirm: (lang: Lang) => L(lang, "अभी कुछ पक्का करने के लिए नहीं है। बताइए, क्या चाहिए?", "There is nothing to confirm yet. What do you need?"),
  patientNeedsAge: (lang: Lang) => L(lang, "नए मरीज़ की उम्र चाहिए। उम्र बताइए।", "A new patient needs an age. Please tell me the age."),
};
