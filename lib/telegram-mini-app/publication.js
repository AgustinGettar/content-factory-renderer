// Read-only copy suggestions, derived from episode metadata. This module never
// schedules, publishes, calls a model or changes a video's approval.
const clean=(value,max)=>Array.from(String(value??'').replace(/[\u0000-\u001f]/g,' ').replace(/\s+/g,' ').trim()).slice(0,max).join('');
export function publicationDraft({title,objective}={}){
 const name=clean(title,160)||'Una nueva aventura de Lumi',topic=name.toLocaleLowerCase('es');
 let text;
 if(/lumi y los animales de la granja$/.test(topic))text='🐮🐑🐔 ¿Quién hace «muu»? Lumi nos lleva a la granja para descubrir la vaca, la oveja y la gallina y jugar con sus sonidos. ✨ Una pequeña aventura para aprender en familia. 💛 Guardalo para volver a jugar juntos. #Lumi #AnimalesDeLaGranja #SonidosDeAnimales #AprenderJugando #EducacionInfantil';
 else if(/lumi y las tres flores de colores$/.test(topic))text='🌼✨ Tres flores y un mundo de colores por descubrir. Acompañá a Lumi en una aventura para mirar, reconocer y aprender jugando. 💛 Compartí este momento en familia y guardalo para volver a descubrir los colores juntos. #Lumi #ColoresParaNiños #AprenderJugando #EducacionInfantil #EnFamilia';
 else if(/lumi y el jard[ií]n de las formas$/.test(topic))text='🔵🔺🟨 ¡El jardín de Lumi está lleno de formas! Círculo, triángulo y cuadrado se convierten en una aventura para descubrir en familia. ✨ ¿Qué formas encuentran a su alrededor? 💛 Guardalo para seguir jugando juntos. #Lumi #FormasGeometricas #AprenderJugando #EducacionInfantil #EnFamilia';
 else if(/lumi y los cinco huevos perdidos$/.test(topic))text='🥚✨ ¡Hay cinco huevos por encontrar! Acompañá a Lumi en una pequeña aventura para contar y descubrir juntos. 💛 Un momento para aprender jugando en familia. Guardalo para volver a contar del uno al cinco. #Lumi #AprenderAContar #NumerosParaNiños #AprenderJugando #EducacionInfantil';
 else text=`✨ ${name}. ${objective?'Hoy exploramos: '+clean(objective,300)+' ':''}💛 Una historia para descubrir y compartir en familia. Guardalo para volver a aprender jugando con Lumi. #Lumi #AprenderJugando #EducacionInfantil #EnFamilia`;
 return {version:1,status:'DRAFT',text,review_required:true};
}
