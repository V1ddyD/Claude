import { normalise, isSalam } from './normalise';
import { checkLanguage, withoutProfanity } from './moderation';

/**
 * Understanding what the customer asked for, without a model.
 *
 * Pattern matching, not intelligence — and the honest consequence is that it
 * handles the paths a dealership actually sees and says so plainly when it
 * cannot. It is deterministic, which makes it a genuinely useful thing to
 * demonstrate a workflow with: the same sentence produces the same result
 * every time.
 *
 * Three passes, in order:
 *
 *   moderation      swearing, insults and slurs are noticed on the raw text,
 *                   and swearing is taken out so a real question with a swear
 *                   word in it is still read as the question it is
 *   normalisation   slang, misspellings and everyday Malay are turned into the
 *                   words the patterns were written against (normalise.ts)
 *   classification  one intent, chosen by how unambiguous each signal is
 *
 * NOTHING here knows a dealership's catalogue.
 *
 * Model names arrive as a vocabulary read from the tenant's own range, and
 * trims, colours and powertrains are captured as the words the customer used
 * and resolved later against what the tools actually returned. That is the
 * difference between a demo and a product: add a model to the catalogue and it
 * is understood on the next request, with no change here.
 *
 * It drives the SAME tools the model does. Swapping this for Claude changes
 * which client the conversation uses and nothing else.
 */

export type Intent =
  // The conversation itself.
  | 'greeting'
  | 'how_are_you'
  | 'who_are_you'
  | 'thanks'
  | 'goodbye'
  | 'acknowledge'
  | 'compliment'
  | 'complaint'
  | 'abuse'
  | 'privacy'
  | 'injection'
  | 'language'
  // Finding a car.
  | 'search_vehicles'
  | 'range'
  | 'rank'
  | 'best_value'
  | 'recommend'
  | 'compare'
  | 'competitor'
  | 'body_not_built'
  // About one car.
  | 'vehicle_overview'
  | 'powertrains'
  | 'trims'
  | 'colours'
  | 'options'
  | 'features'
  | 'feature_check'
  | 'transmission'
  | 'charging'
  | 'price'
  | 'specs'
  | 'stock'
  | 'delivery'
  // Buying one.
  | 'finance'
  | 'payment'
  | 'purchase'
  | 'promotions'
  | 'insurance'
  | 'registration'
  | 'warranty'
  | 'used_cars'
  | 'home_delivery'
  | 'trade_in'
  // Coming in.
  | 'test_drive'
  | 'cancel'
  | 'hours'
  | 'location'
  | 'about_company'
  | 'careers'
  // A person.
  | 'callback'
  | 'human'
  | 'service'
  | 'unknown';

/** Purchase timeframes, as the signals schema defines them. */
export type Timeframe =
  | 'immediately'
  | 'within_30_days'
  | 'one_to_three_months'
  | 'three_to_six_months'
  | 'over_six_months';

/**
 * The axis a "which is best" question is asking to be ranked on.
 *
 * Mirrors the tool's own enum rather than being a looser vocabulary of its
 * own: a criterion this recognises but the tool does not accept is a question
 * that gets classified and then silently dropped.
 */
export type RankCriterion =
  | 'price_low'
  | 'price_high'
  | 'power'
  | 'electric_range'
  | 'efficiency'
  | 'popularity';

export interface Understanding {
  intent: Intent;
  /** The text the classifier actually read: normalised, swearing removed. */
  normalised: string;
  /** Set whenever the intent is 'rank'. Never guessed for anything else. */
  rankCriterion?: RankCriterion;
  /**
   * A body shape they asked for that nothing in this schema can be.
   *
   * The catalogue's body styles are a fixed set, so a hatchback or a
   * convertible is not "a car we happen not to stock" — it is a car this
   * dealership does not build, which is a fact worth stating plainly instead
   * of letting the question fall through to a shrug.
   */
  unbuiltBody?: string;
  /** Catalogue slugs the message named, in the order they appeared. */
  modelSlugs: string[];
  /**
   * Content words, for resolving against real trims, colours and powertrains.
   *
   * Captured loosely and resolved strictly: a word that matches nothing in the
   * catalogue is simply dropped, so over-capturing here is safe and
   * under-capturing is not.
   */
  words: string[];
  /** Named pieces of equipment ("carplay", "heated seats"), in canonical form. */
  featureTerms: string[];
  budgetCents?: number;
  bodyStyle?: 'sedan' | 'coupe' | 'suv' | 'crossover' | 'pickup' | 'wagon';
  electric?: boolean;
  hybrid?: boolean;
  awd?: boolean;
  seats?: number;
  /** Shopping for a family: a hint towards the roomier shapes, never a filter on its own. */
  family?: boolean;
  name?: string;
  email?: string;
  phone?: string;
  /** An explicit yes, for confirmation steps. */
  affirmative: boolean;
  /** An explicit no, for the same. */
  negative: boolean;
  /** A few words at most — the length of a reply, not of a question. */
  short: boolean;
  /** Greeted with "salam" or "assalamualaikum", which deserves the greeting back. */
  salam: boolean;
  profane: boolean;
  insult: boolean;
  slur: boolean;
  dateHint?: string;
  termMonths?: number;
  timeframe?: Timeframe;
  financeInterest?: boolean;
  tradeInInterest?: boolean;
  negotiating?: boolean;
  justBrowsing?: boolean;
}

/**
 * The tenant's own range and brand. Read from the catalogue, never hardcoded.
 *
 * The brand matters for one reason: a customer naming another manufacturer is
 * asking about a competitor, and a customer naming THIS one is not. A Toyota
 * dealership's "is the Toyota warranty any good" is a question about its own
 * cars, and must never be answered as a question about someone else's.
 */
export interface Vocabulary {
  models: { slug: string; name: string }[];
  brand?: string;
}

/**
 * Words that are never a trim, a colour or an engine.
 *
 * Everything else the customer typed is offered up for resolution, because
 * this cannot know what a dealership calls its trim levels — "Premium",
 * "Summit", "Ultimate", "Black Edition" — and guessing a shape for them is
 * how a scripted assistant stops working on the next tenant.
 */
const STOP_WORDS = new Set([
  'a', 'about', 'all', 'also', 'am', 'an', 'and', 'any', 'anything', 'are', 'around',
  'as', 'at', 'available', 'be', 'been', 'best', 'but', 'buy', 'buying', 'by', 'can',
  'car', 'cars', 'come', 'comes', 'cost', 'costs', 'could', 'dealership', 'did', 'do',
  'does', 'doing', 'each', 'for', 'from', 'get', 'give', 'go', 'going', 'got', 'guys',
  'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hi', 'him', 'his', 'how',
  'i', 'if', 'in', 'interested', 'into', 'is', 'it', 'its', 'just', 'know', 'like',
  'long', 'looking', 'lot', 'make', 'many', 'me', 'model', 'models', 'month', 'months',
  'more', 'most', 'much', 'my', 'need', 'new', 'no', 'not', 'now', 'of', 'ok', 'on',
  'one', 'only', 'or', 'other', 'our', 'out', 'over', 'own', 'please', 'price',
  'prices', 'range', 'really', 'right', 'same', 'say', 'see', 'she', 'should', 'show',
  'so', 'some', 'spec', 'specs', 'take', 'tell', 'than', 'thanks', 'that', 'the',
  'their', 'them', 'then', 'there', 'these', 'they', 'thing', 'think', 'this',
  'those', 'to', 'today', 'told', 'too', 'two', 'up', 'us', 'use', 'vehicle',
  'vehicles', 'very', 'want', 'was', 'we', 'week', 'weeks', 'well', 'were', 'what',
  'when', 'where', 'which', 'while', 'who', 'why', 'will', 'with', 'would', 'year',
  'years', 'yes', 'you', 'your',
]);

/* -------------------------------------------------------------------------- */
/* Yes and no                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A yes. Read on the raw text as well as the normalised one, because the
 * normaliser turns "boleh" into "can" — which is right for "boleh test drive?"
 * and wrong for "boleh" said on its own in reply to an offer.
 */
const AFFIRMATIVE =
  /\b(yes|yeah|yep|yup|ya|iya|y|sure|sure thing|please|please do|go ahead|go on|that works|sounds good|sounds great|ok|okay|alright|all right|correct|confirm|confirmed|absolutely|definitely|of course|why not|let'?s do it|do it|boleh|baik|setuju|yes please)\b/;

/** Positive phrases that happen to contain "no". */
const NOT_A_NO = /\bno (problem|problems|worries|rush|issue|issues)\b/g;

const NEGATIVE =
  /\b(no|nope|nah|no thanks|no thank you|not now|not really|not yet|maybe later|later|i'?m good|i'?m ok|i'?m fine|not interested|don'?t|do not|never mind|nothing|tak|tidak|nda|inda|bukan|takpe|tak apa)\b/;

/* -------------------------------------------------------------------------- */
/* Equipment                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Things a customer asks whether a car HAS.
 *
 * Canonical name first, then how people say it. The canonical name is also
 * what is searched for in the equipment and option lists the tools return,
 * alongside the customer's own words — so "CarPlay" finds "Wireless Apple
 * CarPlay" and "sunroof" finds "Panoramic glass roof".
 */
const FEATURES: [string, RegExp][] = [
  ['carplay', /\b(carplay|apple car ?play)\b/],
  ['android auto', /\bandroid auto\b/],
  ['sunroof', /\b(sunroof|moon ?roof|panoramic( glass)? roof|glass roof|panoramic)\b/],
  ['heated seats', /\b(heated (front |rear )?seats?|seat heat\w*)\b/],
  ['ventilated seats', /\b(ventilated|cooled|cooling) seats?\b/],
  ['massage seats', /\bmassag\w* seats?\b/],
  ['leather', /\b(leather|nappa)\b/],
  ['cruise control', /\b(adaptive )?cruise control\b/],
  ['lane assist', /\blane (assist|keep\w*|departure|centr\w*)\b/],
  ['blind spot', /\bblind ?spot\b/],
  ['parking sensors', /\b(parking sensors?|park(ing)? assist|sensors)\b/],
  ['camera', /\b(reversing camera|rear camera|backup camera|360( degree)? camera|surround view|cameras?)\b/],
  ['head-up display', /\b(head.?up display|hud)\b/],
  ['wireless charging', /\b(wireless charg\w*|wireless phone charg\w*|phone charg\w*)\b/],
  ['bluetooth', /\bbluetooth\b/],
  ['navigation', /\b(navigation|satnav|gps)\b/],
  ['keyless', /\b(keyless|push (button )?start|remote start)\b/],
  ['towing', /\b(tow ?bar|towing (package|pack|hitch)|tow hitch)\b/],
  ['roof rails', /\broof (rails?|rack)\b/],
  ['alloy wheels', /\b(alloys?|alloy wheels?|rims)\b/],
  ['headlights', /\b(led (head)?lights?|matrix (led|lights?)|headlights?)\b/],
  ['sound system', /\b(sound system|speakers?|premium audio|audio system|stereo|bose|harman|burmester|bang (and|&) olufsen)\b/],
  ['display', /\b(touch ?screen|screen size|infotainment|big screen)\b/],
  ['climate control', /\b(climate control|dual.?zone|tri.?zone|three.?zone|air ?con\w*|aircon)\b/],
  ['air suspension', /\b(air suspension|adaptive suspension|adaptive damp\w*)\b/],
  ['tailgate', /\b(power|electric|powered|hands.?free) tailgate\b/],
  ['third row', /\b(third row|3rd row|seven seats|7 seats)\b/],
  ['isofix', /\b(isofix|child seats?|baby seats?)\b/],
  ['airbags', /\bairbags?\b/],
  ['driver assist', /\b(autopilot|self.?driving|autonomous|driver assist\w*)\b/],
];

function findFeatures(lower: string): string[] {
  return FEATURES.filter(([, pattern]) => pattern.test(lower)).map(([name]) => name);
}

/* -------------------------------------------------------------------------- */
/* The patterns                                                                */
/* -------------------------------------------------------------------------- */

/** Attempts to talk the assistant out of its job. Answered neutrally, never obeyed. */
const INJECTION =
  /\b(ignore (all |any |your |the |these )?(previous |prior |above |earlier )?(instructions|rules|prompts?|directions)|disregard (all |your |the )?(instructions|rules|prompt)|system prompt|your (instructions|prompt|rules|programming|guidelines)|reveal (your|the) (prompt|instructions|rules|system|code)|developer mode|dev mode|admin mode|god mode|jailbreak|dan mode|you are now|from now on you|pretend (to be|you are|you're)|act as (a|an|if|my)|roleplay|sudo|drop table|select \* from|union select|<script|javascript:|api key|access token|admin password|database dump)\b/;

/** Other people's information. Never shared, never confirmed, never denied. */
const PRIVACY =
  /\b(other (customers?|people|clients?|buyers?)'?s? (details|info|information|data|bookings?|emails?|numbers?|names?)|who (else )?(has |have )?(booked|bought|reserved|enquired|test driven)|customer (list|data|details|records|database|info)|(their|his|her|someone'?s|somebody'?s|another customer'?s) (email|phone|number|address|details|booking|information)|list (of )?(customers|bookings|leads|appointments)|all (your |the )?(customers|bookings|leads|appointments)|leads? (list|data)|show me (the |all )?(bookings|appointments|leads|customers)|previous (owner|customer|buyer)'?s? (details|info|information|name|number|contact))\b/;

/** "Did Jo book a drive?" — about somebody else, however it is phrased. */
const SOMEONE_ELSES_BOOKING =
  /\b(did|has|have) (?!you\b|i\b|we\b|it\b|they\b|the\b|this\b|that\b|there\b)[a-z]+( [a-z]+)? (book|booked|bought|buy|purchase|purchased|reserve|reserved|enquire|enquired)\b/;

const COMPLAINT =
  /\b(complain\w*|complaint|not happy|unhappy|disappointed|disappointing|terrible (service|experience)|horrible|worst (service|experience|dealer\w*)|rude|bad (service|experience)|poor service|angry|furious|refund|ripped off|rip off|(service|experience|staff|salesman|salesperson|team) (was|is|has been|were) (terrible|awful|bad|poor|horrible|shocking|appalling|unacceptable|rubbish|a joke))\b/;

const WHO_ARE_YOU =
  /\b(are you (a |an )?(bot|robot|ai|human|real|person|real person|machine|computer|automated|chatbot)|am i (talking|speaking|chatting) (to|with)|who am i (talking|speaking|chatting) (to|with)|who is this|who are you(?! guys)|what'?s your name|what is your name|is this (a bot|automated|an ai|ai|a real person|a human|a person)|you a bot)\b/;

const HUMAN =
  /\b(speak to|talk to|speak with|talk with|salesperson|sales person|someone|a human|a person|real person|advisor|adviser|agent|manager|staff member)\b/;

/** A car that is being fixed, as opposed to one being bought. */
const SERVICE =
  /\b(servic\w*|repair\w*|maintenance|mot|oil change|recall|bodyshop|parts|broken|breakdown|broke down|warning light|check engine)\b/;

const WARRANTY = /\b(warrant(y|ies)|guarantee)\b/;

const TEST_DRIVE =
  /\b(test drives?|drive it|come in and drive|book a drive|driving it|take (it|one|her) for a (spin|drive)|go for a spin|try (it|one) out|drive (one|the \w+)|see (it|one|the car) in person|view (it|the car|one)|viewing|book (a |an )?(visit|viewing|appointment)|make an appointment|schedule (a |an )?(visit|viewing|appointment|drive))\b/;

const COMPETITOR_BRANDS = [
  'toyota', 'honda', 'nissan', 'mazda', 'mitsubishi', 'subaru', 'suzuki', 'lexus',
  'infiniti', 'acura', 'hyundai', 'kia', 'genesis', 'bmw', 'mercedes', 'merc', 'benz',
  'audi', 'volkswagen', 'vw', 'porsche', 'volvo', 'tesla', 'byd', 'proton', 'perodua',
  'ford', 'chevrolet', 'chevy', 'jeep', 'dodge', 'land rover', 'range rover', 'jaguar',
  'peugeot', 'renault', 'citroen', 'isuzu', 'geely', 'chery', 'haval', 'polestar',
];

const BEST_VALUE =
  /\b(best value|value for money|worth (it|the extra|the money|the upgrade|the step)|worth (paying|going) up|which trim should|what do (i|you) get for the extra|bang for (your|the) buck)\b/;

const RECOMMEND =
  /\b(what should (i|we) (buy|get|go for|look at)|which (one )?(should|would) (i|you)|what do you recommend|any recommendations?|recommend (me )?(one|a|something)|help me (choose|decide|pick)|(i'?m |im )?not sure what (i want|to get)|what would you (suggest|recommend|go for)|which is best for|best (car|one) for|what'?s good for|suggest (a|one|something))\b/;

const HOME_DELIVERY =
  /\b(do you deliver|deliver (it|the car|to (my|me|your)|home)|home delivery|delivered to (my|me)|drop (it|the car) off)\b/;

const DELIVERY =
  /\b(how (long|soon)|lead time|waiting (list|time)|delivery time|when (can|could|would) (i|we) (get|have|take|collect)|how quickly can|order time|turnaround)\b/;

const RANGE =
  /\b((what|which) (other |else )?(cars?|models?|vehicles?) (do|have|are|can|you (got|have|sell|do))|(cars?|models?) (do )?you (got|have|sell)|what (else )?do you (make|sell|build|offer|do)|show me (the |your )?(range|lineup|line.?up|models?|cars?|everything)|(the|your|full|whole|entire) (range|lineup|line.?up)\b|all (of )?(your|the) (cars?|models?)|what'?s in the range|list (the |your )?(cars?|models?)|what (cars?|models?) (are there|are available|do you have))/;

const CHARGING =
  /\b(charging|charger|chargers|charge time|to charge|fast charg\w*|rapid charg\w*|home charg\w*|charging point|charge (it|at home|the car|overnight)|how long (does it take )?to charge|plug.?in)\b/;

const PURCHASE =
  /\b(ready to buy|want to buy|like to buy|i'?ll take (it|one)|i will take (it|one)|how (do|can) i (buy|purchase|order|get one)|buy (it|one) now|place (an|the|my) order|order (one|it)|reserve (it|one|the car|a car)|put (down )?a deposit|pay (a|the) deposit|hold (it|one|the car) for me|sign (the )?(papers|paperwork|contract)|make it mine)\b/;

const PROMOTIONS =
  /\b(promo|promos|promotions?|special offers?|any offers|current offers|latest offers|deals|any deal|cashback|rebates?|on sale|sale on|(year|month) end (sale|offers?)|raya (offers?|promo|sale))\b/;

const PAYMENT =
  /\b(pay(ing)? (with|by|in|using|via|cash|full|upfront|outright)|payment (method|option|plan)s?|how (do|can) i pay|credit card|debit card|bank transfer|cheque|pay in full|full payment|deposit)\b/;

const INSURANCE = /\b(insur\w*|comprehensive cover)\b/;

const REGISTRATION =
  /\b(registration|register (the|my) car|road ?tax|number plates?|licen[cs]e plates?|plates)\b/;

const USED =
  /\b(used (cars?|ones?|vehicles?|models?|stock)|any used|second hand|pre-?owned|ex-?demo|demo (car|model)s?|certified pre)\b/;

const HOURS =
  /\b(open|opening hours|opening times|what time|when are you|closing time|close today|closed on|business hours|operating hours|your hours)\b/;

const LOCATION =
  /\b(where are you|where is (the |your )?(showroom|dealership|shop|branch)|address|located|location|directions|how (do|can) i get (there|to you)|google maps|waze|branch(es)?|near me|phone number|contact number|whatsapp|email address)\b/;

const CONTACT_US = /\b(how (can|do) (i|we) (contact|reach)|contact (details|number|info))\b/;

const ABOUT_COMPANY =
  /\b(about (the |your )?(company|dealership|brand|business|you guys)|who (are|is) (you guys|your company|the company)|tell me about (yourselves|your company|the company|the dealership|the brand|you guys)|how long have you (been|existed)|what is (this|your) (company|dealership|brand)|your (company|dealership|brand) (history|story))\b/;

const CAREERS =
  /\b(job (openings?|vacanc\w*|applications?)|any jobs|hiring|vacanc\w*|careers?|work for you|internships?|apply for a (job|position))\b/;

const LANGUAGE =
  /\b((speak|cakap|talk|chat|understand|reply|respond) (in )?(malay|bahasa|melayu|chinese|mandarin)|bahasa melayu|in malay|dalam bahasa)\b/;

const HOW_ARE_YOU =
  /\b(how are you|how r you|how're you|how's it going|how is it going|how's your day|how are things|how you doing|how do you do|what khabar|what's up|sup)\b/;

const TRANSMISSION =
  /\b(manual|automatic|auto gearbox|gearbox|transmission|stick shift|cvt|dct|paddle shift\w*)\b/;

const COMPLIMENT =
  /\b(you'?re (so |very |really )?(helpful|great|amazing|awesome|brilliant|the best|smart|good)|very helpful|so helpful|super helpful|good bot|great bot|nice bot|love (it|this|the \w+|your \w+)|(looks?|sounds?) (amazing|great|awesome|beautiful|gorgeous|stunning|lovely|nice)|beautiful car|nice car|great car|gorgeous|stunning|impressive)\b/;

const GOODBYE =
  /\b(bye|goodbye|good bye|bye bye|see you|see ya|cya|catch you later|talk (to you )?later|ttyl|that'?s all|that is all|nothing else|i'?m done|all good thanks|have a (good|nice|great) (day|one|night|evening|weekend)|good night|take care)\b/;

const THANKS = /\b(thanks|thank you|cheers|appreciate|appreciated|much obliged)\b/;

const GREETING =
  /^\s*(hi|hello|hey|hiya|howdy|yo|greetings|good (morning|afternoon|evening|day)|morning|evening|afternoon)\b/;

/** A reply that acknowledges rather than asks. Only counted when it is short. */
const ACKNOWLEDGE =
  /^(ok|okay|ok cool|okay cool|cool|nice|great|alright|all right|got it|i see|noted|sure|sounds good|perfect|awesome|fine|right|understood|makes sense|good|excellent|wow|oh|ah|hmm|interesting|oh nice|oh ok|ok then|ok thanks|lovely|brilliant|fair enough)$/;

/* -------------------------------------------------------------------------- */
/* Reading a message                                                           */
/* -------------------------------------------------------------------------- */

export function understand(text: string, vocabulary?: Vocabulary): Understanding {
  const language = checkLanguage(text);
  // Classified with the swearing removed, so "how much is the bloody X7" is
  // still read as the price question it is.
  const cleaned = language.profane ? withoutProfanity(text) : text;
  const lower = normalise(cleaned);
  const raw = text.toLowerCase();

  const negative = NEGATIVE.test(raw.replace(NOT_A_NO, ' ')) || NEGATIVE.test(lower.replace(NOT_A_NO, ' '));
  const words = lower.replace(/[^a-z0-9' ]/g, ' ').trim().split(/\s+/).filter(Boolean);

  const result: Understanding = {
    intent: 'unknown',
    normalised: lower,
    modelSlugs: findModels(lower, vocabulary),
    words: contentWords(lower),
    featureTerms: findFeatures(lower),
    affirmative: !negative && (AFFIRMATIVE.test(raw) || AFFIRMATIVE.test(lower)),
    negative,
    short: words.length <= 5,
    salam: isSalam(text),
    profane: language.profane,
    insult: language.insult,
    slur: language.slur,
  };

  result.bodyStyle = findBodyStyle(lower);
  if (/\b(electric|ev|evs|battery|bev|fully electric|all.?electric)\b/.test(lower)) result.electric = true;
  if (/\b(hybrid|hybrids|phev|self.?charging)\b/.test(lower)) result.hybrid = true;
  if (/\b(awd|all.?wheel|4wd|4x4|four.?wheel|quattro|off.?road\w*)\b/.test(lower)) result.awd = true;

  const seats = /\b(\d)\s*-?\s*(?:seat|seats|seater)\b/.exec(lower);
  if (seats) result.seats = Number(seats[1]);
  const spelledSeats = /\b(five|six|seven|eight)\s*-?\s*(?:seat|seats|seater)\b/.exec(lower);
  if (spelledSeats) result.seats = { five: 5, six: 6, seven: 7, eight: 8 }[spelledSeats[1] as 'five']!;

  // A family is a reason to look at the roomier shapes. It is only ever a
  // hint, and only when they have not named a shape themselves.
  if (/\b(family|families|kids|children|school run|baby|toddlers?)\b/.test(lower) || (result.seats ?? 0) >= 6) {
    result.family = true;
    result.bodyStyle ??= 'suv';
  }

  const email = /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(text);
  if (email) result.email = email[0].replace(/[.,;:]+$/, '');

  // Looked for in the text with the address already removed: an email is full
  // of digits and punctuation, and half of one reads convincingly as a number.
  const phone = findPhone(email ? text.replace(email[0], ' ') : text);
  if (phone) result.phone = phone;

  result.name = findName(text);
  result.dateHint = findDate(lower);

  const term = /\b(\d{2})\s*(?:months?|mos?)\b/.exec(lower);
  if (term) result.termMonths = Number(term[1]);

  // A phone number is not a budget and a mileage is not a budget. Both are
  // taken out before a figure is read as one.
  result.budgetCents = findBudget(
    [result.email, result.phone]
      .filter((value): value is string => Boolean(value))
      .reduce((rest, value) => rest.replace(value.toLowerCase(), ' '), lower),
  );

  result.timeframe = findTimeframe(lower);
  if (/\b(financ\w*|leas\w*|monthly|per month|a month|each month|apr|instal\w*|credit (check|score|rating|application|approval)|on credit|loan|down ?payment|interest rate|hire purchase)\b/.test(lower)) {
    result.financeInterest = true;
  }
  if (/\b(trade.?ins?|part.?exchange|my old car|trade in my|sell my car|sell you my)\b/.test(lower)) {
    result.tradeInInterest = true;
  }
  if (isNegotiating(lower)) result.negotiating = true;
  if (/\b(just (looking|browsing)|no rush|not (buying|ready)|window shopping)\b/.test(lower)) {
    result.justBrowsing = true;
  }

  const unbuilt = findUnbuiltBody(lower);
  if (unbuilt) result.unbuiltBody = unbuilt;

  const criterion = findRankCriterion(lower);
  if (criterion) result.rankCriterion = criterion;

  result.intent = classify(lower, result, vocabulary);

  // Swearing and nothing else worth answering is the conversation's problem,
  // not a question: asked, kindly, to keep it friendly.
  if (result.profane && result.intent === 'unknown') result.intent = 'abuse';

  // Carried only where it was actually asked for. A criterion left on a
  // question that turned out to be about something else is a ranking waiting
  // to be run against an intent that never wanted one.
  if (result.intent !== 'rank') delete result.rankCriterion;
  return result;
}

/**
 * The axis a superlative is asking about.
 *
 * Order matters more than the patterns do. "Cheapest to run" is a question
 * about fuel, not about price, and "best value" is a question about a trim
 * ladder rather than about either — so the specific readings are tested before
 * the general ones, and the bare "cheapest" only wins once they have all
 * declined it.
 */
function findRankCriterion(lower: string): RankCriterion | undefined {
  // Running costs first: every one of these contains a price word, so testing
  // them after "cheapest" would read "cheapest to run" as a question about
  // the price list.
  if (
    /\b(cheapest to run|cheap to run|economical|economy|fuel efficient|most efficient|best (fuel )?(economy|mileage|mpg)|least fuel|lowest consumption|frugal|good on (fuel|petrol|gas))\b/.test(
      lower,
    )
  ) {
    return 'efficiency';
  }

  if (
    /\b(most popular|popular(?!\s+(?:options?|packages?|colou?rs?|trims?|features?|extras))|best.?sell\w*|top.?sell\w*|sells the most|biggest seller|most common|everyone.?s (buying|getting)|what (do|are) (people|most people|others) (buy|buying|get|getting)|trending|in demand)\b/.test(
      lower,
    )
  ) {
    return 'popularity';
  }

  if (
    /\b(fastest|quickest|most powerful|most power|sportiest|sporty|sports cars?|performance cars?|highest (horsepower|hp|output)|most hp|biggest engine|top speed|performance model)\b/.test(
      lower,
    )
  ) {
    return 'power';
  }

  if (
    /\b(longest range|most range|best range|furthest|farthest|goes the furthest|biggest battery|longest on a charge)\b/.test(
      lower,
    )
  ) {
    return 'electric_range';
  }

  // "Your lowest price" is haggling and belongs to a person; "the lowest
  // priced car" is a fact about the range. Only the second sense is here.
  if (
    /\b(cheapest|cheaper|least expensive|less expensive|most affordable|more affordable|lower priced|entry.?level|budget (option|model|one)|where does the range start|what does the range start at)\b/.test(
      lower,
    )
  ) {
    return 'price_low';
  }

  if (
    /\b(most expensive|dearest|priciest|top of the range|flagship|range.?topping|most premium|highest priced?|top spec model)\b/.test(
      lower,
    )
  ) {
    return 'price_high';
  }

  return undefined;
}

/**
 * One intent for one message.
 *
 * Ordered by how unambiguous the signal is, so a sentence containing several
 * cues resolves to the one the customer most likely meant. The order is the
 * design; each group says why it sits where it does.
 *
 * Plurals are spelled out rather than relied on: \b after "engine" does not
 * match "engines", and a classifier that silently misses every plural sends
 * half the questions a dealership gets down the wrong branch.
 */
function classify(lower: string, parsed: Understanding, vocabulary?: Vocabulary): Intent {
  const named = parsed.modelSlugs.length;

  // --- Before anything else: messages that must not be answered as asked ----
  //
  // A slur or an insult is never treated as a question, however much of one
  // it also contains. Instructions to the assistant and requests for other
  // people's details are answered the same way whatever else they say.
  if (parsed.slur || parsed.insult) return 'abuse';
  if (INJECTION.test(lower)) return 'injection';
  if (PRIVACY.test(lower) || SOMEONE_ELSES_BOOKING.test(lower)) return 'privacy';

  // --- A person, or a change to something already booked --------------------
  if (/\b(cancel\w*|can'?t make( it)?|cannot make( it)?|reschedul\w*|move my (booking|appointment|test drive))\b/.test(lower)) {
    return 'cancel';
  }
  // Asking to be phoned is a callback; asking to speak to someone is a
  // handoff. Both are "I want a person", and the difference is only how.
  if (/\b(call ?back|call me|ring me|phone me|give me a (call|ring))\b/.test(lower)) return 'callback';
  if (COMPLAINT.test(lower)) return 'complaint';
  // "Are you a real person?" is a question about the assistant, not a request
  // for a person, and it has to be answered honestly.
  if (WHO_ARE_YOU.test(lower)) return 'who_are_you';
  if (HUMAN.test(lower)) return 'human';
  // Negotiation goes to a person. Quoting list price at someone asking for a
  // discount answers a question they did not ask, and no assistant here has
  // the authority to answer the one they did (spec §15).
  if (parsed.negotiating) return 'human';

  // --- After-sales, and the pre-sale question that sounds like it -----------
  if (SERVICE.test(lower)) return 'service';
  if (WARRANTY.test(lower)) return 'warranty';
  if (parsed.tradeInInterest || /\bwhat(?:'?s| is) my .{0,40}\bworth\b/.test(lower)) {
    return 'trade_in';
  }
  if (TEST_DRIVE.test(lower)) return 'test_drive';

  // --- What they want, before which car they want it in ---------------------
  //
  // A shape we do not build is said before any search is attempted: searching
  // for a hatchback returns nothing, and "nothing matches that" leaves the
  // customer wondering whether they asked it wrong.
  if (parsed.unbuiltBody) return 'body_not_built';
  if (namesACompetitor(lower, vocabulary)) return 'competitor';
  // "Which trim is worth the money" is a question about one car's ladder, so it
  // is tested before the superlatives — every phrasing of it contains a price
  // word, and half of them contain "best".
  if (BEST_VALUE.test(lower)) return 'best_value';
  // A named piece of equipment. With a price word it is an options question,
  // because an option is the thing with a price.
  if (parsed.featureTerms.length > 0) {
    return /\b(how much|price|cost|extra)\b/.test(lower) ? 'options' : 'feature_check';
  }
  // "Does it come with a roof box?" is a yes-or-no question about one piece of
  // kit, even when the kit is not one this knows by name. "What does it come
  // with?" is a request for the list, and is left for 'features' below.
  if (
    /^(does|do|will|would|is|are|has|have|can) (it|they|this|that|the [\w-]+|[a-z]{1,3}\s?\d{1,3})? ?(come with|comes with|have|has|include|includes|get|got|offer|feature)\b/.test(lower) &&
    !/^(does|do) .*\b(come with|have|include)\b\s*(\?|$)/.test(lower)
  ) {
    return 'feature_check';
  }
  // A superlative with an axis behind it. The axis had to be recognised for
  // this to fire, so there is always a real measure to rank on.
  if (parsed.rankCriterion && named < 2) return 'rank';
  // Open-ended, and the only honest reply is a question back. Never when they
  // have named two cars: that is a comparison and it has its own tool.
  if (named < 2 && RECOMMEND.test(lower)) return 'recommend';

  // --- Getting one, and how soon --------------------------------------------
  if (HOME_DELIVERY.test(lower)) return 'home_delivery';
  if (DELIVERY.test(lower) && !CHARGING.test(lower)) return 'delivery';
  // The whole range. Placed before the stock check because "what cars do you
  // have" is asking what we build, not what is on the forecourt today — and
  // with a budget or a shape attached it is a search, not the catalogue.
  if (
    RANGE.test(lower) &&
    named === 0 &&
    !parsed.budgetCents &&
    !(parsed.bodyStyle && !parsed.family) &&
    !parsed.electric &&
    !parsed.hybrid
  ) {
    return 'range';
  }
  if (CHARGING.test(lower)) return 'charging';

  // --- Paying for it ----------------------------------------------------------
  if (parsed.financeInterest || /\b(per month|a month|each month)\b/.test(lower)) return 'finance';
  if (PURCHASE.test(lower)) return 'purchase';
  if (PROMOTIONS.test(lower)) return 'promotions';
  if (PAYMENT.test(lower)) return 'payment';
  if (INSURANCE.test(lower)) return 'insurance';
  if (REGISTRATION.test(lower)) return 'registration';
  if (USED.test(lower)) return 'used_cars';

  // --- What is on the ground -------------------------------------------------
  //
  // "Available" is the ambiguous one. "Do you have any S5s?" asks what is on
  // the forecourt; "what trims are available on the S5?" asks what the factory
  // builds, and answering that with a stock list is answering a different
  // question. So a message that names a part of the car — a trim, a colour, an
  // engine, an option — is asking about the CATALOGUE, and only the
  // unmistakably forecourt phrasings override that.
  const namesAFacet =
    /\b(trims?|versions?|grades?|levels?|colou?rs?|paint|engines?|motors?|powertrains?|drivetrains?|options?|packages?|features?|equipment|specs?|kit)\b/.test(
      lower,
    );
  const onTheForecourt = /\b(in stock|on the lot|on the floor|ready to go|got any|any left|on site|ready now)\b/.test(lower);

  if (onTheForecourt || (/\b(availab\w*|do you have)\b/.test(lower) && !namesAFacet)) {
    // "What SUVs do you have around 50k?" is a search worded as a stock
    // question. Without a named car there is nothing to check the lot for.
    const searchable =
      parsed.bodyStyle || parsed.budgetCents || parsed.electric || parsed.hybrid || parsed.seats;
    if (named > 0 || !searchable) return 'stock';
  }
  if (/\b(compare|comparison|versus| vs |vs\.| v |difference between|differences between|which is better)\b/.test(` ${lower} `)) {
    return 'compare';
  }

  // --- The dealership --------------------------------------------------------
  if (HOURS.test(lower)) return 'hours';
  // "contact" only where it asks for ours. "Please contact me" is a customer
  // agreeing to be called, not a request for the showroom address.
  if (LOCATION.test(lower) || CONTACT_US.test(lower)) return 'location';
  if (named === 0 && (ABOUT_COMPANY.test(lower) || aboutTheBrand(lower, vocabulary))) return 'about_company';
  if (CAREERS.test(lower)) return 'careers';
  if (LANGUAGE.test(lower)) return 'language';
  if (HOW_ARE_YOU.test(lower)) return 'how_are_you';

  // --- One car, one aspect ---------------------------------------------------
  if (/\b(colou?rs?|paint|shades?)\b/.test(lower)) return 'colours';
  if (TRANSMISSION.test(lower)) return 'transmission';
  if (/\b(options?|packages?|extras|add.?ons?|accessor(y|ies))\b/.test(lower)) return 'options';
  if (/\b(standard|equipment|features?|kit|comes? with|what do (i|you) get|what'?s included|included)\b/.test(lower)) return 'features';
  if (/\b(engines?|motors?|powertrains?|drivetrains?|range|batter(y|ies)|horsepower|hp|power|torque|economy|mpg|litres?|fuel|consumption)\b/.test(lower)) {
    return 'powertrains';
  }
  if (/\b(trims?|versions?|grades?|levels?|variants?)\b/.test(lower)) return 'trims';

  // A measurement question. The catalogue holds engines, trims, colours,
  // options and equipment — it does not hold boot volumes, kerb weights or
  // tow ratings, and no amount of pattern matching will conjure one.
  //
  // Recognising them anyway is the point. A question that is CLASSIFIED can be
  // answered with what we do know about that car plus a real route to the
  // figure; a question that falls through to 'unknown' gets a shrug.
  if (
    /\b(boot|trunk|cargo|luggage|load space|legroom|headroom|dimensions?|length|width|height|wheelbase|ground clearance|weight|kerb weight|curb weight|tow\w*|payload|turning circle|tyres?|tires?|wheel size|0.?60|0.?100|zero to sixty|acceleration|top speed|safety rating|ncap|crash test|how many seats|seats)\b/.test(
      lower,
    )
  ) {
    return 'specs';
  }
  if (/\b(how much|prices?|pricing|costs?|msrp|starting at|starts at|otr|on the road)\b/.test(lower)) return 'price';

  // --- Small talk, once nothing substantive has claimed the message ---------
  if (COMPLIMENT.test(lower)) return 'compliment';
  if (GOODBYE.test(lower)) return 'goodbye';
  if (THANKS.test(lower)) return 'thanks';
  if (GREETING.test(lower)) return 'greeting';
  if (parsed.short && ACKNOWLEDGE.test(lower.replace(/[^a-z' ]/g, '').trim())) return 'acknowledge';

  // A bare colour word routes here only once nothing stronger has claimed the
  // message, so "how much is the S5 in black" is still a price question.
  if (namesAColour(lower) && named > 0) return 'colours';

  // A budget is a search criterion only when they have not said which car.
  // "I want the S5 Premium and I have $55,000" is a configuration with a
  // budget attached, not a request to be shown the range under $55,000.
  if (
    named === 0 &&
    (parsed.budgetCents || parsed.bodyStyle || parsed.electric || parsed.hybrid || parsed.seats)
  ) {
    return 'search_vehicles';
  }
  if (named > 1) return 'compare';

  // Naming a car is not the same as asking something answerable about it.
  // "Does the S5 tow a three horse trailer?" gets an honest route to the
  // figure rather than an overview that answers a question nobody asked.
  if (named === 1 && wantsOverview(lower)) return 'vehicle_overview';

  return 'unknown';
}

/**
 * A question about another manufacturer. Never this dealership's own brand.
 *
 * Naming a brand is not enough. "2019 Toyota Camry, 80,000 km" is a customer
 * describing the car they want to trade in — an answer to our own question —
 * and treating it as a question about a competitor derailed the appraisal.
 * It takes a brand AND a reason to think they are asking about it: a
 * comparison, or whether we sell one.
 */
function namesACompetitor(lower: string, vocabulary?: Vocabulary): boolean {
  const own = vocabulary?.brand?.toLowerCase();
  const brand = COMPETITOR_BRANDS.some(
    (name) => name !== own && new RegExp(`\\b${name}s?\\b`).test(lower),
  );
  return (
    brand &&
    /\b(vs|versus|compar\w*|better|worse|than|similar|sell|carry|stock|have any|do you (do|have|sell)|dealer\w*|instead of|against|or a|or the)\b/.test(
      lower,
    )
  );
}

/** "Tell me about Sinclair" — the brand, with no car named after it. */
function aboutTheBrand(lower: string, vocabulary?: Vocabulary): boolean {
  const brand = vocabulary?.brand?.toLowerCase();
  if (!brand) return false;
  const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, (m) => `\\${m}`);
  return new RegExp(`\\b(about|who (is|are)|what is|what's) ${escaped}\\b`).test(lower);
}

/**
 * Haggling, as opposed to asking which car costs least.
 *
 * "What's your lowest?" and "which is the cheapest one you make?" are
 * different questions with different right answers — one goes to a person who
 * can actually move on price, the other is a fact about the range. So the
 * price words here all carry a second-person aim: it is a price being asked
 * OF US, not a price being compared BETWEEN cars.
 */
function isNegotiating(lower: string): boolean {
  return /\b(best price|best you can do|discount|deal on|knock (off|something)|beat (that|this)|haggl\w*|negotiat\w*|cash price|(your|the) lowest\b(?! priced)|lowest you)\b/.test(
    lower,
  );
}

function wantsOverview(lower: string): boolean {
  if (
    /\b(tell me about|about the|what'?s the|what is the|overview|interested in|looking at|show me|more on|details on|i want|i'?d like|i am after|thinking about|considering|any good|is it good|good for|suitable for|worth (it|buying)|how is the|what'?s it like|what is it like|info on|information on|describe|explain)\b/.test(
      lower,
    )
  ) {
    return true;
  }
  // "the S5", "S5?" — a bare mention is a request to hear about it.
  return lower.replace(/[^a-z0-9\s]/g, ' ').trim().split(/\s+/).length <= 4;
}

/**
 * Models the message named, from the tenant's own range.
 *
 * Matched on the slug and on the name — both the whole of it and the part
 * after the brand, since "Sinclair S5", "the S5" and "s5" are the same car and
 * a customer uses all three.
 */
function findModels(lower: string, vocabulary?: Vocabulary): string[] {
  const found: string[] = [];

  for (const model of vocabulary?.models ?? []) {
    const aliases = new Set<string>([model.slug.toLowerCase(), model.name.toLowerCase()]);
    const words = model.name.trim().split(/\s+/);
    // "Sinclair S5" -> "s5". Dropped only when something is left to drop to.
    if (words.length > 1) aliases.add(words.slice(1).join(' ').toLowerCase());

    const matched = [...aliases].some((alias) => {
      const escaped = alias
        .replace(/[.*+?^${}()|[\]\\]/g, (char) => `\\${char}`)
        // "S 5", "s-5" and "S5" are the same car; people type all three.
        .replace(/([a-z])(\d)/g, (_, letter: string, digit: string) => `${letter}[\\s-]?${digit}`);
      // The optional plural is not cosmetic: "do you have any S5s in stock" is
      // how the question is actually asked. Word-boundary matched so a
      // single-letter model does not fire on every stray letter.
      return new RegExp(`\\b${escaped}s?\\b`).test(lower);
    });

    if (matched) found.push(model.slug);
  }

  return found;
}

function contentWords(lower: string): string[] {
  return [...new Set(
    (lower.match(/[a-z0-9][a-z0-9.'-]*/g) ?? []).filter(
      (word) => word.length > 1 && !STOP_WORDS.has(word),
    ),
  )];
}

function findBudget(lower: string): number | undefined {
  // A distance is never a price, so mileage is removed before anything is read
  // as a figure.
  const text = lower
    .replace(/\d[\d,\s]*\s*(km|kms|kilometres|kilometers|miles|mi)\b/g, ' ')
    // "fifty thousand", "50 grand"
    .replace(/\bgrand\b/g, 'k');

  const withK = /(\d{1,3})\s?k\b/.exec(text);
  if (withK) {
    const value = Number(withK[1]) * 1000;
    if (plausible(value)) return value * 100;
  }

  const grouped = /(\d{1,3})[,\s](\d{3})\b/.exec(text);
  if (grouped) {
    const value = Number(`${grouped[1]}${grouped[2]}`);
    if (plausible(value)) return value * 100;
  }

  const plain = /\b(\d{4,6})\b/.exec(text);
  if (plain) {
    const value = Number(plain[1]);
    if (plausible(value)) return value * 100;
  }

  const spelled = findSpelledBudget(text);
  if (spelled && plausible(spelled)) return spelled * 100;

  return undefined;
}

/** "around fifty thousand", "sixty five thousand". */
function findSpelledBudget(text: string): number | undefined {
  const units: Record<string, number> = {
    twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
    eighty: 80, ninety: 90,
  };
  const ones: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  };

  const match = /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[\s-](one|two|three|four|five|six|seven|eight|nine))?\s+thousand\b/.exec(
    text,
  );
  if (!match) return undefined;
  return (units[match[1]!]! + (match[2] ? ones[match[2]]! : 0)) * 1000;
}

/** Wide enough for a used runabout, narrow enough to exclude a year or a postcode. */
function plausible(value: number): boolean {
  return value >= 5_000 && value <= 500_000;
}

/**
 * A phone number, by how many digits it has rather than how it is punctuated.
 *
 * A date and a price are both digits and separators too; ten to fifteen digits
 * is what tells them apart.
 */
/**
 * A phone number given in direct reply to a request for one.
 *
 * Looser than findPhone on purpose, and used ONLY when the assistant has just
 * asked for a number. A Brunei number is seven digits, which in free text is
 * as likely to be a stock number or a price; straight after "what's the best
 * number to reach you on?" it is a phone number.
 */
export function phoneFromReply(text: string): string | undefined {
  const withoutEmail = text.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, ' ');
  const match = /(\+?\d[\d\s().-]{5,}\d)/.exec(withoutEmail);
  if (!match) return undefined;
  const digits = match[1]!.replace(/\D/g, '').length;
  return digits >= 7 && digits <= 15 ? match[1]!.trim() : undefined;
}

function findPhone(text: string): string | undefined {
  const match = /(\+?\d[\d\s().-]{7,}\d)/.exec(text);
  if (!match) return undefined;
  const digits = match[1]!.replace(/\D/g, '').length;
  return digits >= 10 && digits <= 15 ? match[1]!.trim() : undefined;
}

function findBodyStyle(lower: string): Understanding['bodyStyle'] {
  if (/\bsuvs?\b/.test(lower)) return 'suv';
  if (/\b(pickups?|trucks?|ute)\b/.test(lower)) return 'pickup';
  if (/\b(coupes?|two.?door)\b/.test(lower)) return 'coupe';
  if (/\bcrossovers?\b/.test(lower)) return 'crossover';
  if (/\b(saloons?|sedans?)\b/.test(lower)) return 'sedan';
  if (/\b(estates?|wagons?)\b/.test(lower)) return 'wagon';
  return undefined;
}

/**
 * When they intend to buy, mapped onto the bands the scoring rules use.
 *
 * Only from something they said about timing. Enthusiasm is not a timeframe,
 * and a wrongly confident "immediately" is what sends a salesperson after
 * somebody who is a year away (spec §11).
 */
function findTimeframe(lower: string): Timeframe | undefined {
  if (/\b(today|right now|immediately|asap|as soon as possible|this week)\b/.test(lower)) {
    return 'immediately';
  }
  if (/\b(this month|within (a|the) month|next month|(in|within) 30 days|few weeks|couple of weeks)\b/.test(lower)) {
    return 'within_30_days';
  }
  if (/\b((in|within|next) (two|three|2|3) months?|couple of months|next quarter)\b/.test(lower)) {
    return 'one_to_three_months';
  }
  if (/\b((in|within) (four|five|six|4|5|6) months?|later this year|end of the year)\b/.test(lower)) {
    return 'three_to_six_months';
  }
  if (/\b(next year|in a year|over a year|no rush|sometime|eventually)\b/.test(lower)) {
    return 'over_six_months';
  }
  return undefined;
}

function findName(text: string): string | undefined {
  // Only an explicit introduction. Guessing a name from arbitrary capitalised
  // words puts wrong data in front of a salesperson, which is worse than none.
  //
  // Case is spelled out rather than flagged: /i/ would apply to the capture
  // too, and the capitalisation is the only thing separating a name from an
  // ordinary word.
  const patterns = [
    /\b(?:[Ii]'?m|[Ii] am|[Mm]y name is|[Tt]his is|[Ii]t'?s)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
    /\b[Nn]ame'?s\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1] && !/^(looking|interested|just|here|not|after)$/i.test(match[1])) {
      return match[1];
    }
  }
  return undefined;
}

function findDate(lower: string): string | undefined {
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const named = days.find((day) => lower.includes(day));
  if (named) return named;
  if (/\btomorrow\b/.test(lower)) return 'tomorrow';
  if (/\bthis week\b/.test(lower)) return 'this week';
  if (/\bnext week\b/.test(lower)) return 'next week';
  if (/\bweekend\b/.test(lower)) return 'saturday';
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(lower);
  return iso?.[1];
}

/**
 * A name given in direct reply to a request for one.
 *
 * Separate from findName on purpose. Guessing a name from any capitalised word
 * is how wrong data reaches a salesperson, so that only ever happens here —
 * after the assistant has asked for a name and the customer is answering it.
 */
export function nameFromReply(text: string): string | undefined {
  const introduced = findName(text);
  if (introduced) return introduced;

  const stripped = text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, ' ')
    .replace(/\+?\d[\d\s().-]{5,}/g, ' ')
    .replace(
      /\b(yes|yeah|yep|sure|ok|okay|please|thanks|thank you|hi|hello|and|my|name|is|it'?s|i'?m|i am|that'?s|fine|contact|me|you|can|sounds good)\b/gi,
      ' ',
    )
    .replace(/[^A-Za-z'\-\s]/g, ' ');

  const capitalised = stripped.match(/\b[A-Z][a-zA-Z'-]+\b/g) ?? [];
  if (capitalised.length >= 1 && capitalised.length <= 3) return capitalised.join(' ');

  // Plenty of people type their name in lower case. Accepted only when what is
  // left after stripping is short enough to be a name and nothing else.
  const words = stripped.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 1 && words.length <= 3 && words.every((w) => w.length >= 2)) {
    return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');
  }
  return undefined;
}

/** The alphabet booking codes are drawn from — no vowels, no lookalikes. */
export function findConfirmationCode(text: string): string | undefined {
  return /\b([23456789BCDFGHJKLMNPQRSTVWXZ]{6})\b/.exec(text.toUpperCase())?.[1];
}

/** "the second one", "number 2", "2" — a choice from a numbered list. */
export function findOrdinal(text: string): number | undefined {
  const words = ['first', 'second', 'third', 'fourth', 'fifth'];
  const lower = text.toLowerCase();
  const word = words.findIndex((w) => new RegExp(`\\b${w}\\b`).test(lower));
  if (word >= 0) return word;
  const digit = /\b(?:option|number|slot)?\s*([1-5])\b(?!\s*(?:am|pm|:|k\b))/.exec(lower);
  return digit ? Number(digit[1]) - 1 : undefined;
}

export interface TradeInVehicle {
  year?: number;
  make?: string;
  model?: string;
  mileageKm?: number;
  condition?: 'excellent' | 'good' | 'fair' | 'poor';
}

/** "2019 Toyota Camry, 80,000 km, good condition". */
export function findTradeInVehicle(text: string): TradeInVehicle {
  const vehicle: TradeInVehicle = {};

  // The model is taken as everything between the make and the end of the
  // phrase, because plenty of them carry digits or two words — "3 Series",
  // "Model 3", "C-Class" — and a single-word capture loses half of them.
  const named =
    /\b(19[5-9]\d|20[0-4]\d)\s+([A-Za-z][\w-]{1,20})(?:\s+([A-Za-z0-9][\w-]*(?:\s+[A-Za-z0-9][\w-]*)?))?/.exec(
      text,
    );
  if (named) {
    vehicle.year = Number(named[1]);
    vehicle.make = named[2];
    const model = named[3]?.replace(/\s+(with|worth|and|at|in|for|is)$/i, '').trim();
    if (model && !/^(with|at|and|worth|is|in|for)$/i.test(model)) vehicle.model = model;
  } else {
    const year = /\b(19[5-9]\d|20[0-4]\d)\b/.exec(text);
    if (year) vehicle.year = Number(year[1]);
  }

  const mileage = /\b(\d{1,3}(?:[,\s]\d{3})+|\d{1,6})\s*(k\b|km|kms|kilometres|kilometers|miles|mi)\b/i.exec(text);
  if (mileage) {
    const amount = Number(mileage[1]!.replace(/[,\s]/g, ''));
    const unit = mileage[2]!.toLowerCase();
    // "80k" means eighty thousand; miles are converted, because the field is km
    // and storing a mile count in it would understate every trade-in by 60%.
    const km = unit === 'k' ? amount * 1000 : amount;
    vehicle.mileageKm = unit === 'miles' || unit === 'mi' ? Math.round(km * 1.60934) : km;
  }

  const condition = /\b(excellent|good|fair|poor)\b/i.exec(text);
  if (condition) vehicle.condition = condition[1]!.toLowerCase() as TradeInVehicle['condition'];

  return vehicle;
}

/**
 * Colour words, as a language fact rather than a catalogue one.
 *
 * Used ONLY to notice that a colour was mentioned. Which colours exist, what
 * they are called and what they cost all come from the catalogue — so a
 * dealership whose palette is nothing like this one still works.
 */
const COLOUR_WORDS = [
  'black', 'white', 'grey', 'gray', 'silver', 'red', 'blue', 'green', 'yellow',
  'orange', 'purple', 'pink', 'brown', 'beige', 'cream', 'gold', 'bronze', 'copper',
  'teal', 'turquoise', 'lime', 'maroon', 'navy', 'olive', 'tan', 'ivory',
  'champagne', 'burgundy',
];

function namesAColour(lower: string): boolean {
  return COLOUR_WORDS.some((name) => new RegExp(`\\b${name}\\b`).test(lower));
}

/** Every colour word in a message, for resolving against the real palette. */
export function colourWords(text: string): string[] {
  const lower = text.toLowerCase();
  return COLOUR_WORDS.filter((name) => new RegExp(`\\b${name}\\b`).test(lower));
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Whether something the customer said picks out an offered time.
 *
 * Matched against the label the diary produced, never re-derived from the
 * timestamp: the customer chose from the words they were shown, so those are
 * the words their answer has to agree with.
 */
export function saidMatchesSlot(label: string, said: string): boolean {
  // Intl puts a narrow no-break space between the time and a.m./p.m.
  const shown = label.toLowerCase().replace(/\./g, '').replace(/[  ]/g, ' ');
  const text = said.toLowerCase().replace(/\./g, '');

  const day = DAYS.find((name) => text.includes(name));
  if (day && !shown.includes(day)) return false;

  const time = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.exec(text);
  if (time) return shown.includes(`${Number(time[1])}:${time[2] ?? '00'} ${time[3]}`);

  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
  if (iso) return label.includes(iso[1]!);

  return Boolean(day);
}

/**
 * Which of the times the assistant listed the customer picked.
 *
 * Resolved against the list as it was actually shown — parsed back out of the
 * assistant's own message — so "the first one" keeps meaning the time on the
 * screen even if the diary has moved on since.
 */
export function chosenFromOffer(offered: string, said: string): string | undefined {
  const labels = [...offered.matchAll(/^\s*(\d)\.\s+(.+?)\s*$/gm)].map((m) => m[2]!);
  if (labels.length === 0) return undefined;

  const index = findOrdinal(said);
  if (index !== undefined && index < labels.length) return labels[index];

  const matched = labels.filter((label) => saidMatchesSlot(label, said));
  return matched.length === 1 ? matched[0] : undefined;
}

/**
 * A criterion given in direct answer to "what matters most?".
 *
 * Deliberately looser than the superlative patterns, and used ONLY after the
 * assistant has asked. "Price" on its own is not a request to rank the range
 * by price — it is half a dozen other questions — but "price" said straight
 * after being asked what matters most is exactly that, and a customer who
 * answers the question they were asked should not be told it was not
 * understood.
 */
export function criterionFromReply(text: string): RankCriterion | undefined {
  const direct = findRankCriterion(text.toLowerCase());
  if (direct) return direct;

  const lower = text.toLowerCase();
  if (/\b(running costs?|fuel|petrol|diesel|mpg|economy|efficien\w*|consumption)\b/.test(lower)) {
    return 'efficiency';
  }
  if (/\b(range|charge|charging|battery|electric)\b/.test(lower)) return 'electric_range';
  if (/\b(power|performance|speed|fast|pace|sporty|quick)\b/.test(lower)) return 'power';
  if (/\b(price|cost|budget|cheap|affordab\w*|money|spend)\b/.test(lower)) return 'price_low';
  if (/\b(popular|common|others|everyone|people)\b/.test(lower)) return 'popularity';
  return undefined;
}

/**
 * Body shapes a customer asks for that this catalogue has no way to hold.
 *
 * The body style column is a fixed set: sedan, coupe, SUV, crossover, pickup,
 * wagon. A hatchback or a convertible is therefore not a car this dealership
 * happens to be out of — it is one they do not build, and saying so is both
 * true and more useful than a search that returns nothing.
 *
 * Kept deliberately short. A word that might be one of the real shapes under
 * another name ("estate" for a wagon, "saloon" for a sedan) belongs in
 * findBodyStyle, not here: telling somebody we do not build an estate when the
 * wagon is sitting on the forecourt would be a lie with a straight face.
 */
const UNBUILT_BODIES: [RegExp, string][] = [
  [/\b(hatch ?backs?|hatches)\b/, 'hatchback'],
  [/\b(convertibles?|cabriolets?|roadsters?|drop ?tops?|soft ?tops?)\b/, 'convertible'],
  [/\b(mini ?vans?|mpvs?|people carriers?)\b/, 'minivan'],
  [/\b(camper ?vans?|motorhomes?)\b/, 'camper van'],
  [/\b(motor ?(bikes?|cycles?)|scooters?)\b/, 'motorbike'],
];

function findUnbuiltBody(lower: string): string | undefined {
  return UNBUILT_BODIES.find(([pattern]) => pattern.test(lower))?.[1];
}
