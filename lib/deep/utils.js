'use strict'
const debug = require('debug')('eps:deep/utils')
const updater = require('js-object-updater')
const async = require('async-q')
const Q = require('q')
const _ = require('lodash')

const getEntity = function(entityCache, eId, type, es) {
  var key = eId + type
  if (!type || !eId) {
    throw new Error('Id or type missing in getEntity: ' + eId + ' type ' + type)
  }
  if (entityCache[key]) {
    return Q(entityCache[key])
  } else {
    return es.get.collect({
      index: type + 's',
      id: eId,
      type: type
    })
    .then((entity) => {
      if (!entity._source) {
        throw new Error('Entity not found. Type and id: ' + type + ' & ' +  eId)
      } else {
        entityCache[key] = entity
        return entity
      }
    })
  }
}

const recalculateUnionInSibling = function(field, entity, updatedEntity, relation, relatedEId, cachedEntities, es) {

  const relatedEntityType = fieldType(updatedEntity._type, relation)
  debug('recalculateUnionInSibling', updatedEntity._type, updatedEntity._id, 'updated field ', field, 'new value', updatedEntity._source[field], 'old value', entity && entity._source[field], 'relation', relation, 'related entity type', relatedEntityType, 'relatedEId', relatedEId)

  return getEntity(cachedEntities, relatedEId, relatedEntityType, es)//Load the entity in cache
  .then(() => {
    const relatedEntity = cachedEntities[relatedEId + relatedEntityType]
    //Initialize meta for field if necessary
    relatedEntity._source.meta = relatedEntity._source.meta || {}
    relatedEntity._source.meta[field] = relatedEntity._source.meta[field] || {}

    if (entity) {
      //Decrement counts in meta for the removed values from the entity
      let decrements = _.difference(_.flatten([entity && entity._source[field]]), _.flatten([updatedEntity._source[field]]))
      decrements = _.compact(decrements)
      decrements.forEach((value) => {//Update related entity accordingly
        relatedEntity._source.meta[field][value] -= 1
      })
      debug('decrements', decrements, updatedEntity._source[field], relatedEntity._source.meta)
    }
    //Increment the count in meta of added values to the entity
    let increments = _.flatten([updatedEntity._source[field]])
    if (entity) {
      increments = _.difference(increments, _.flatten([entity._source[field]]))
    }
    increments = _.compact(increments)
    increments.forEach((value) => {//Update related entity accordingly
      relatedEntity._source.meta[field][value] = relatedEntity._source.meta[field][value] || 0
      relatedEntity._source.meta[field][value] += 1
    })
    debug('increments', increments, relatedEntity._source[field], relatedEntity._source.meta)

    //Now calculate new field value in related entity through the meta desrciptor
    let newFieldValue = _.transform(relatedEntity._source.meta[field], (result, value, key) => {
      if (!_.isUndefined(value) && value > 0) {
        result.push(key)
      }
    }, [])
    //Update the related entity and its tree with the new field value
    return es.deep.update(
      {
        _id: relatedEntity._id,
        _type: relatedEntity._type,
        update: {set: {[field]: newFieldValue}}
      },
      cachedEntities
    )
    .catch((err) => {
      debug('Err in recursive update', err)
    })
  })
}

module.exports.recalculateUnionInSibling = recalculateUnionInSibling
module.exports.getEntity = getEntity