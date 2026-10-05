// Closed, versioned performance grammar; no model, translations service or prompt enhancer.
export const PROJECTION_VERSION = 'lumi-cinematic-projection/2';
export const GRAMMAR_VERSION = 'lumi-performance-grammar/2';
export const GRAMMAR = Object.freeze({
  GREETING: { v2_action: 'small_wave', hand: true },
  PRESENT_FLOWER: { v2_action: 'small_pointing_gesture', hand: true },
  ATTENTIVE_WAIT: { v2_action: 'look_at_viewer', hand: false },
  GAZE_VIEWER: { v2_action: 'look_at_viewer', hand: false },
  FAREWELL: { v2_action: 'small_wave', hand: true },
});
export const LABELS = Object.freeze({
  flower_red: { en: 'the red flower', es: 'la flor roja' },
  flower_yellow: { en: 'the yellow flower', es: 'la flor amarilla' },
  flower_blue: { en: 'the blue flower', es: 'la flor azul' },
  viewer: { en: 'the viewer', es: 'el espectador' },
});
const SHOTS = {
  ESTABLISHING: ['an establishing shot', 'un plano de presentación'],
  MEDIUM_TEACHING: ['a teaching medium shot', 'un plano medio de enseñanza'],
  CLOSE_EMOTION: ['an expressive close shot', 'un plano cercano expresivo'],
  EDUCATIONAL_OBJECT: ['a shot focused on the teaching object', 'un plano centrado en el objeto educativo'],
  MAGIC_REWARD: ['a warm reward shot', 'un plano cálido de celebración'],
  QUESTION_TO_VIEWER: ['a question addressed to the viewer', 'un plano de pregunta al espectador'],
};
const SECONDARY = {
  blink: ['one natural blink', 'un parpadeo natural'],
  smile: ['a gentle smile', 'una sonrisa suave'],
  natural_settle: ['a small relaxed settling of the active gesture', 'un pequeño asentamiento relajado del gesto activo'],
  subtle_wing_response: ['a tiny response of the existing wings', 'una respuesta mínima de las alas existentes'],
};
const CAMERAS = {
  STATIC: ['The camera remains fixed.', 'La cámara permanece fija.'],
  SUBTLE_PUSH_IN: ['The camera makes one subtle push-in, keeping Lumi and the teaching objects readable.', 'La cámara se acerca suavemente una sola vez, manteniendo legibles a Lumi y los objetos educativos.'],
  SUBTLE_REFRAME: ['The camera makes one subtle reframe within the reviewed composition.', 'La cámara realiza un único reencuadre sutil dentro de la composición revisada.'],
  GENTLE_TRACKING: ['The camera follows the approved gentle tracking path.', 'La cámara sigue el recorrido suave aprobado.'],
};
export function projectCinematicPrompt(plan, language = 'en') {
  const d = plan.direction, c = plan.contract, a = d.principal_actions[0];
  const i = language === 'es' ? 1 : 0, es = i === 1;
  const target = LABELS[a.target]?.[language];
  if (!target || !GRAMMAR[a.grammar]) throw new Error('UNRESOLVED_GRAMMAR');
  const hand = a.body_part === 'character_left_forearm' ? (es ? 'su antebrazo izquierdo' : 'her own left forearm') : (es ? 'su antebrazo derecho' : 'her own right forearm');
  const actions = {
    GREETING: es
      ? `Lumi saluda al espectador con un único gesto pequeño de ${hand}, expresión cálida y contacto visual; luego asienta la mano con naturalidad.`
      : `Lumi greets the viewer with one small gesture of ${hand}, a warm expression and eye contact, then lets the hand settle naturally.`,
    PRESENT_FLOWER: es
      ? `Lumi prepara un gesto pequeño con ${hand}, señala junto a ${target} sin cubrir sus pétalos y asienta el gesto con naturalidad, para que su color se lea con claridad.`
      : `Lumi prepares a small gesture with ${hand}, points beside ${target} without covering its petals, and settles naturally so its color is easy to read.`,
    ATTENTIVE_WAIT: es
      ? 'Lumi mantiene contacto visual cálido con el espectador y una expresión de escucha curiosa, dando espacio para responder sin señalar ni mirar la respuesta.'
      : 'Lumi keeps warm eye contact with the viewer and a curious listening expression, giving room to answer without pointing or looking toward the answer.',
    GAZE_VIEWER: es
      ? 'Lumi dirige suavemente la mirada al espectador, con expresión cálida y curiosa, y asienta la mirada.'
      : 'Lumi gently brings her gaze to the viewer with a warm, curious expression, then settles her gaze.',
    FAREWELL: es
      ? `Lumi prepara un saludo pequeño con ${hand} hacia el espectador y asienta la mano con naturalidad, cerrando el encuentro con calidez.`
      : `Lumi prepares one small farewell wave with ${hand} toward the viewer and lets the hand settle naturally, bringing the encounter to a warm close.`,
  };
  const clauses = [
    es ? `Lumi, el personaje de la imagen de entrada, en ${SHOTS[c.shot_type][i]}. Conserva el acabado premium stylized 3D CGI de la fuente.`
      : `Lumi, the character in the input image, in ${SHOTS[c.shot_type][i]}. Preserve the source's premium stylized 3D CGI finish.`,
    actions[a.grammar],
    es ? 'El torso conserva su orientación inicial; los pies permanecen apoyados y el contorno posterior conserva su silueta.'
      : 'The torso keeps its initial orientation; the feet remain grounded and the rear contour retains its silhouette.',
    d.secondary_motion.length ? (es ? 'Acompaña el gesto con ' : 'Accompany the performance with ') + d.secondary_motion.map(x => SECONDARY[x][i]).join(es ? ' y ' : ' and ') + '.' : '',
    es ? 'Los objetos educativos mantienen cantidad, color, forma, posición y visibilidad. La ropa, los accesorios presentes, la iluminación y el jardín permanecen estables.'
      : 'The teaching objects keep their count, color, shape, position and visibility. Clothing, existing accessories, lighting and the garden remain stable.',
    CAMERAS[d.camera.type][i],
    es ? `Una toma continua de ${c.DURATION} segundos, con ritmo natural. ` : `One continuous ${c.DURATION}-second shot at a natural pace. `,
    a.grammar === 'ATTENTIVE_WAIT'
      ? (es ? `La ventana final de respuesta de ${a.timing.response_window} segundos conserva vida sutil y escucha atenta, sin congelar la pose.` : `The final ${a.timing.response_window}-second response window retains subtle life and attentive listening, without freezing the pose.`)
      : (es ? 'Termina con el gesto asentado y una expresión cálida.' : 'End with the gesture settled and a warm expression.'),
    es ? 'Deja libre el espacio revisado para captions; sin texto generado ni cortes.' : 'Keep the reviewed caption space clear; no generated text or cuts.',
  ].filter(Boolean);
  return { text: clauses.join(' '), clauses: clauses.map((text, index) => ({ index, text })), language, version: PROJECTION_VERSION,
    timing_limit: 'Timing guides planning and QA; text does not guarantee frame-accurate model timing.' };
}
